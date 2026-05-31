import { Daytona, type Sandbox } from "@daytona/sdk";

export interface DaytonaSandboxDriverConfig {
  apiKey: string;
  testResourcePrefix: string;
  operationTimeoutSeconds?: number;
}

export interface CreateSandboxInput {
  name: string;
  env?: Record<string, string>;
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

    const sandbox = await this.daytona.create(
      {
        name: input.name,
        language: "typescript",
        envVars: input.env,
        labels: {
          agentrouter: "true",
          prefix: this.config.testResourcePrefix
        },
        ephemeral: true,
        autoDeleteInterval: 0
      },
      { timeout: this.config.operationTimeoutSeconds ?? 300 }
    );

    this.sandboxes.set(sandbox.id, sandbox);

    return {
      id: sandbox.id,
      name: sandbox.name
    };
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
