import { runFlow } from "../../lib/agents/flow-runner";

// We use jest to spy on process.exit

describe("FlowRunner", () => {
  const originalExit = process.exit;

  beforeEach(() => {
    // Clear any set environment variables that might interfere
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_EVENT_PATH = "./dummy-event.json";
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("should exit with code 1 when GITHUB_TOKEN is missing", async () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`process.exit: ${code}`); });
    try {
      await runFlow();
    } catch (e: any) {
      expect(e.message).toBe("process.exit: 1");
    }
    exitSpy.mockRestore();
  });
});
