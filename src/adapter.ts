import * as vscode from "vscode";
import {
  TestAdapter,
  TestEvent,
  TestLoadFinishedEvent,
  TestLoadStartedEvent,
  TestRunFinishedEvent,
  TestRunStartedEvent,
  TestSuiteEvent,
} from "vscode-test-adapter-api";
import { Log } from "vscode-test-adapter-util";
import { runFakeTests } from "./fakeTests";
import {
  mapJestTotalResultToTestSuiteInfo,
} from "./helpers/mapJestToTestAdapter";
import JestManager from "./JestManager";

interface IDiposable {
  dispose(): void;
}

type TestStateCompatibleEvent = TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent;

/**
 * This class is intended as a starting point for implementing a "real" TestAdapter.
 * The file `README.md` contains further instructions.
 */
export default class JestTestAdapter implements TestAdapter {

  private disposables: IDiposable[] = [];

  private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
  private readonly testStatesEmitter = new vscode.EventEmitter<TestStateCompatibleEvent>();
  private readonly autorunEmitter = new vscode.EventEmitter<void>();

  get autorun(): vscode.Event<void> | undefined {
    return this.autorunEmitter.event;
  }

  get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
    return this.testsEmitter.event;
  }

  get testStates(): vscode.Event<TestStateCompatibleEvent> {
    return this.testStatesEmitter.event;
  }

  constructor(
    public readonly workspace: vscode.WorkspaceFolder,
    private readonly log: Log,
  ) {

    this.log.info("Initializing example adapter");

    this.disposables.push(this.testsEmitter);
    this.disposables.push(this.testStatesEmitter);
    this.disposables.push(this.autorunEmitter);

  }

  public async load(): Promise<void> {

    this.log.info("Loading example tests");

    this.testsEmitter.fire({ type: "started" } as TestLoadStartedEvent);

    const jest = new JestManager(this.workspace);
    const jestResults = await jest.loadTests();
    const suite = mapJestTotalResultToTestSuiteInfo(jestResults, this.workspace.uri.fsPath);

    this.testsEmitter.fire({ type: "finished", suite } as TestLoadFinishedEvent);

  }

  public async run(tests: string[]): Promise<void> {

    this.log.info(`Running example tests ${JSON.stringify(tests)}`);

    this.testStatesEmitter.fire({ type: "started", tests } as TestRunStartedEvent);

    // in a "real" TestAdapter this would start a test run in a child process
    await runFakeTests(tests, this.testStatesEmitter);

    this.testStatesEmitter.fire({ type: "finished" } as TestRunFinishedEvent);

  }

  public async debug(tests: string[]): Promise<void> {
    // in a "real" TestAdapter this would start a test run in a child process and attach the debugger to it
    this.log.warn("debug() not implemented yet");
    throw new Error("Method not implemented.");
  }

  public cancel(): void {
    // in a "real" TestAdapter this would kill the child process for the current test run (if there is any)
    throw new Error("Method not implemented.");
  }

  public dispose(): void {
    this.cancel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}