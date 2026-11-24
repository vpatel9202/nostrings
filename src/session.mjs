// Host side of a session. Cells run in a separate no-privilege runner process
// (runner.mjs, started by isolation.mjs); this side hosts the Broker
// (broker.mjs), which holds the backends, approvals and action log and
// answers the runner's requests. The runner (and every binding in it) lives
// until reset() or the host exits. There is no idle teardown here; the CLI
// daemon applies its own idle limit.
import { Broker } from "./broker.mjs";
import { describeIsolation, startRunner } from "./isolation.mjs";
import { transformCell } from "./transform.mjs";

const ABORT_GRACE_MS = 5000;

export class Session {
  constructor({ client = "An agent", imageMode = "inline", start = startRunner, brokerOptions = {} } = {}) {
    this.client = client;
    this.imageMode = imageMode;
    this.broker = null;
    this.starting = null;
    this.lastUsed = Date.now();
    this.isolation = null;
    this.#launch = start;
    this.#brokerOptions = brokerOptions;
  }

  #launch;
  #brokerOptions;
  #warn = null; // isolation warnings, shown with the first result after a start

  async #start() {
    const runner = await this.#launch();
    const broker = new Broker({
      runner,
      client: this.client,
      imageMode: this.imageMode,
      ...this.#brokerOptions,
      onExit: (b) => {
        if (this.broker === b) this.broker = null;
      },
    });
    this.broker = broker;
    this.isolation = runner.isolation;
    const warnings = runner.isolation?.warnings ?? [];
    if (warnings.length) {
      this.#warn = `nostrings warning: ${warnings.join("; ")}. Scripts are less isolated than usual (${describeIsolation(runner.isolation)}); run \`nostrings doctor\`.`;
      process.stderr.write(`${this.#warn}\n`);
    }
    return broker;
  }

  async #broker() {
    if (this.broker && !this.broker.closed) return this.broker;
    this.starting ??= this.#start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async run(code, { title, timeoutMs = 120_000 } = {}) {
    this.lastUsed = Date.now();
    let transformed;
    try {
      transformed = transformCell(String(code ?? ""));
    } catch (error) {
      return { ok: false, content: [{ type: "text", text: error.name === "SyntaxError" ? error.message : `${error.name}: ${error.message}` }] };
    }
    let broker;
    try {
      broker = await this.#broker();
    } catch (error) {
      return { ok: false, content: [{ type: "text", text: error.message }] };
    }
    let timer;
    let killer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        // Stop the script: the broker refuses its requests from now on, and
        // the runner is asked to stop at its next action. Kill it if it won't.
        broker.abort(`Stopped: the script ran longer than ${timeoutMs} ms.`);
        killer = setTimeout(() => {
          if (this.broker === broker) this.broker = null;
          broker.kill();
          resolve({
            ok: false,
            content: [{ type: "text", text: `The script ran longer than ${timeoutMs} ms and did not stop, so the session was restarted. Bindings were lost.` }],
          });
        }, ABORT_GRACE_MS);
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([broker.eval(transformed, { title }), timeout]);
      if (this.#warn) {
        result.content = [{ type: "text", text: this.#warn }, ...(result.content ?? [])];
        this.#warn = null;
      }
      return result;
    } finally {
      clearTimeout(timer);
      clearTimeout(killer);
      this.lastUsed = Date.now();
    }
  }

  reset() {
    const broker = this.broker;
    this.broker = null;
    if (broker) broker.kill("SIGTERM");
    // A runner still starting is ended as soon as it is up.
    this.starting?.then(
      (started) => {
        if (this.broker === started) this.broker = null;
        started.kill("SIGTERM");
      },
      () => {},
    );
  }

  close() {
    this.reset();
  }
}
