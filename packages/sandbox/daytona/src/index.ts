import { Daytona, type Sandbox } from "@daytona/sdk";

export interface DaytonaSandboxDriverConfig {
  apiKey: string;
  testResourcePrefix: string;
  operationTimeoutSeconds?: number;
}

export interface CreateSandboxInput {
  name: string;
  env?: Record<string, string>;
  /**
   * Persistent sandbox for multi-turn sessions: not ephemeral, auto-stops when
   * idle (suspend), auto-archives/deletes much later. One-shot runs leave this
   * false and keep the delete-on-finish behavior.
   */
  persistent?: boolean;
  /** Idle minutes before Daytona auto-stops a persistent sandbox (default 15). */
  autoStopIntervalMinutes?: number;
  autoArchiveIntervalMinutes?: number;
  autoDeleteIntervalMinutes?: number;
}

export interface SandboxHandle {
  id: string;
  name?: string;
}

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class DaytonaSandboxDriver {
  private readonly daytona: Daytona;
  private readonly sandboxes = new Map<string, Sandbox>();

  constructor(private readonly config: DaytonaSandboxDriverConfig) {
    this.daytona = new Daytona({
      apiKey: config.apiKey
    });
  }

  async createSandbox(input: CreateSandboxInput): Promise<SandboxHandle> {
    if (!input.name.startsWith(this.config.testResourcePrefix)) {
      throw new Error("Sandbox name must use the configured test resource prefix");
    }

    const persistentParams = input.persistent
      ? {
          ephemeral: false,
          autoStopInterval: input.autoStopIntervalMinutes ?? 15,
          autoArchiveInterval: input.autoArchiveIntervalMinutes ?? 60,
          // Daytona-side backstop (default 90m, down from 24h). The app-side
          // reaper normally reclaims well before this; it's the last-resort net.
          autoDeleteInterval: input.autoDeleteIntervalMinutes ?? 90
        }
      : { ephemeral: true, autoDeleteInterval: 0 };

    const sandbox = await this.daytona.create(
      {
        name: input.name,
        language: "typescript",
        envVars: input.env,
        labels: {
          agentrouter: "true",
          prefix: this.config.testResourcePrefix
        },
        ...persistentParams
      },
      { timeout: this.config.operationTimeoutSeconds ?? 300 }
    );

    this.sandboxes.set(sandbox.id, sandbox);

    return {
      id: sandbox.id,
      name: sandbox.name
    };
  }

  /** Suspend (stop) a persistent sandbox — fast, fs preserved, not billed as running. */
  async suspendSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    await this.daytona.stop(sandbox);
    // Drop the cached handle so the next op re-fetches fresh state.
    this.sandboxes.delete(sandboxId);
  }

  /** Resume (start) a suspended sandbox. */
  async resumeSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.daytona.get(sandboxId);
    await this.daytona.start(sandbox, this.config.operationTimeoutSeconds ?? 120);
    const refreshed = await this.daytona.get(sandboxId);
    this.sandboxes.set(sandboxId, refreshed);
  }

  /** Current Daytona state ('started' | 'stopped' | ...), or undefined if gone. */
  async getSandboxState(sandboxId: string): Promise<string | undefined> {
    try {
      const sandbox = await this.daytona.get(sandboxId);
      return sandbox.state ? String(sandbox.state) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Adjust the idle auto-stop TTL on a live sandbox. */
  async setIdleTtl(sandboxId: string, minutes: number): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    const maybe = sandbox as unknown as {
      setAutostopInterval?: (m: number) => Promise<void>;
    };
    if (typeof maybe.setAutostopInterval === "function") {
      await maybe.setAutostopInterval(minutes);
    }
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    options: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number } = {}
  ): Promise<SandboxCommandResult> {
    const sandbox = await this.getSandbox(sandboxId);
    const response = await sandbox.process.executeCommand(
      command,
      options.cwd,
      options.env,
      options.timeoutSeconds
    );

    return {
      exitCode: response.exitCode,
      stdout: response.result,
      stderr: ""
    };
  }

  /**
   * Polls a trivial command until the toolbox/login shell is exec-ready. A
   * freshly created or just-resumed sandbox can report `started` a moment
   * before commands can spawn (otherwise `fork/exec` errors leak through).
   */
  async waitUntilReady(sandboxId: string, attempts = 20): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await this.executeCommand(sandboxId, "echo ready", {
          cwd: "/home/daytona",
          timeoutSeconds: 30
        });
        if (r.exitCode === 0 && r.stdout.includes("ready")) return;
      } catch {
        // not ready yet
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error("sandbox never became command-ready");
  }

  async downloadFile(sandboxId: string, remotePath: string): Promise<Buffer> {
    const sandbox = await this.getSandbox(sandboxId);
    return sandbox.fs.downloadFile(remotePath, 0);
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    await this.daytona.delete(sandbox, this.config.operationTimeoutSeconds ?? 300);
    this.sandboxes.delete(sandboxId);
  }

  private async getSandbox(sandboxId: string): Promise<Sandbox> {
    const existing = this.sandboxes.get(sandboxId);
    if (existing) return existing;

    const sandbox = await this.daytona.get(sandboxId);
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }
}
