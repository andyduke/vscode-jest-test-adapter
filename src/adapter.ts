import { getSettings } from "jest-editor-support";
import * as vscode from "vscode";
import {
  RetireEvent,
  TestAdapter,
  TestEvent,
  TestLoadFinishedEvent,
  TestLoadStartedEvent,
  TestRunFinishedEvent,
  TestRunStartedEvent,
  TestSuiteEvent,
} from "vscode-test-adapter-api";
import { Log } from "vscode-test-adapter-util";
import { emitTestCompleteRootNode, emitTestRunningRootNode } from "./helpers/emitTestCompleteRootNode";
import { filterTree } from "./helpers/filterTree";
import { initProjectWorkspace } from "./helpers/initProjectWorkspace";
import { mapJestTestResultsToTestEvents } from "./helpers/mapJestTestResultsToTestEvents";
import { mapTestIdsToTestFilter } from "./helpers/mapTestIdsToTestFilter";
import { mapTreeToSuite } from "./helpers/mapTreeToSuite";
import { createRootNode, RootNode } from "./helpers/tree";
import JestManager, { IJestManagerOptions } from "./JestManager";
import TestLoader from "./TestLoader";
import { EnvironmentChangedEvent, IDisposable } from "./types";

export type IJestTestAdapterOptions = IJestManagerOptions;

type TestStateCompatibleEvent = TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent;

export default class JestTestAdapter implements TestAdapter {
  private isLoadingTests: boolean = false;
  private isRunningTests: boolean = false;
  private disposables: IDisposable[] = [];
  private tree: RootNode = createRootNode("root");
  private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
  private readonly testStatesEmitter = new vscode.EventEmitter<TestStateCompatibleEvent>();
  private readonly retireEmitter = new vscode.EventEmitter<RetireEvent>();
  private readonly jestManager: JestManager;
  private testLoader: TestLoader | null = null;

  constructor(
    public readonly workspace: vscode.WorkspaceFolder,
    private readonly log: Log,
    private readonly options: IJestTestAdapterOptions,
  ) {
    this.jestManager = new JestManager(workspace, options);

    this.disposables.push(this.testsEmitter);
    this.disposables.push(this.testStatesEmitter);
    this.disposables.push(this.retireEmitter);
  }

  get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
    return this.testsEmitter.event;
  }

  get testStates(): vscode.Event<TestStateCompatibleEvent> {
    return this.testStatesEmitter.event;
  }

  get retire(): vscode.Event<RetireEvent> {
    return this.retireEmitter.event;
  }

  public async load(): Promise<void> {
    if (this.isLoadingTests) {
      this.log.info("Test load in progress, ignoring subsequent call to load tests.");
      return;
    }

    // check if the test loader has been initialized and if not, then do so.
    if (!this.testLoader) {
      try {
        const projectWorkspace = initProjectWorkspace(this.options, this.workspace);

        this.log.info(`Loading Jest settings from ${projectWorkspace.pathToConfig}...`);

        const settings = await getSettings(projectWorkspace);

        this.testLoader = new TestLoader(settings, this.log, projectWorkspace);

        this.disposables.push(this.testLoader.environmentChange(e => this.handleEnvironmentChange(e), this));
        this.disposables.push(this.testLoader);

        this.log.info(`Finished loading Jest settings.`);
      } catch (error) {
        this.log.error("Attempted to load tests when Test Loader has not been initialized.");
        return;
      }
    }

    this.isLoadingTests = true;
    this.log.info("Loading Jest tests...");

    try {
      this.testsEmitter.fire({ type: "started" });

      const state = await this.testLoader.getTestState(true);
      this.tree = state.suite;
      const suite = mapTreeToSuite(this.tree);

      this.testsEmitter.fire({ suite, type: "finished" });
    } catch (error) {
      this.log.error("Error loading tests", JSON.stringify(error));
      this.testsEmitter.fire({ type: "finished", errorMessage: JSON.stringify(error) });
    }

    this.retireAllTests();

    this.log.info("Finished loading Jest tests.");
    this.isLoadingTests = false;
  }

  public async run(tests: string[]): Promise<void> {
    if (this.isRunningTests) {
      this.log.info("Test run in progress, ignoring subsequent call to run tests.");
      return;
    }

    this.log.info(`Running Jest tests... ${JSON.stringify(tests)}`);
    this.isRunningTests = true;
    this.testStatesEmitter.fire({ tests, type: "started" });

    try {
      const testFilter = mapTestIdsToTestFilter(tests);

      const eventEmitter = (data: TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent) =>
        this.testStatesEmitter.fire(data);

      // we emit events to notify which tests we are running.
      const filteredTree = filterTree(this.tree, tests);
      emitTestRunningRootNode(filteredTree, eventEmitter);

      // begin running the tests in Jest.
      const jestResponse = await this.jestManager.runTests(testFilter);

      if (jestResponse) {
        // map the test results to TestEvents
        const testEvents = mapJestTestResultsToTestEvents(jestResponse, filteredTree);

        // emit the completion events.
        emitTestCompleteRootNode(filteredTree, testEvents, eventEmitter);
      }
    } catch (error) {
      this.log.error("Error running tests", JSON.stringify(error));
    }

    this.log.info("Finished loading Jest tests.");
    this.isRunningTests = false;
    this.testStatesEmitter.fire({ type: "finished" });
  }

  public async debug(tests: string[]): Promise<void> {
    const args = ["--runInBand"];
    const testFilter = mapTestIdsToTestFilter(tests);
    if (testFilter) {
      if (testFilter.testFileNamePattern) {
        args.push("--testPathPattern");
        args.push(testFilter.testFileNamePattern);
      }

      if (testFilter.testNamePattern) {
        args.push("--testNamePattern");
        args.push(testFilter.testNamePattern);
      }
    }

    const debugConfiguration: vscode.DebugConfiguration = {
      args,
      console: this.options.debugOutput,
      cwd: "${workspaceFolder}",
      internalConsoleOptions: "neverOpen",
      name: "vscode-jest-test-adapter",
      program: "${workspaceFolder}/node_modules/jest/bin/jest",
      request: "launch",
      type: "node",
    };

    await vscode.debug.startDebugging(this.workspace, debugConfiguration);
  }

  public cancel(): void {
    this.log.info("Closing all active Jest processes");
    this.jestManager.closeAllActiveProcesses();

    // TODO cancel other processes.
  }

  public dispose(): void {
    this.cancel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  private handleEnvironmentChange(e: EnvironmentChangedEvent) {
    switch (e.type) {
      case "App":
        this.retireTestFiles(e.invalidatedTestIds);
        break;

      case "Test":
        try {
          this.log.info("Loading Jest tests...");

          this.testsEmitter.fire({ type: "started" });

          this.tree = e.updatedSuite;
          const suite = mapTreeToSuite(this.tree);
          this.retireTestFiles(e.invalidatedTestIds);

          this.testsEmitter.fire({ suite, type: "finished" });
        } catch (error) {
          this.log.error("Error loading tests", JSON.stringify(error));
          this.testsEmitter.fire({ type: "finished", errorMessage: JSON.stringify(error) });
        }
        break;

      default:
        break;
    }
  }

  /**
   * Invalidates all the tests for the given files.  This works because the file paths are used ids for the tests suites.
   * @param testFiles The files to invalidate the results for.
   */
  private retireTestFiles(testFiles: string[]) {
    this.retireEmitter.fire({
      tests: testFiles,
    });
  }

  /**
   * Marks all tests as retired.
   */
  private retireAllTests() {
    this.retireEmitter.fire({});
  }
}
