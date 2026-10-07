import { createInterface } from "node:readline";

/** Prompts on stderr so stdout stays clean. Input is not echoed when hidden. */
export function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (opts.hidden) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyRl = rl as any;
      anyRl._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stderr.write(question);
      };
    }
    rl.on("SIGINT", () => {
      rl.close();
      reject(new Error("Aborted."));
    });
    rl.question(question, (answer) => {
      if (opts.hidden) process.stderr.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}
