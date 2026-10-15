// Terminal prompts for setup. Secrets are read with echo off, so they never appear on screen.

import { createInterface } from "node:readline/promises";
import type { Prompts } from "./setup-stages.ts";

const { stdin, stdout } = process;

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(`  ${question} `);
  } finally {
    rl.close();
  }
}

/** Reads a line in raw mode without echoing it. Without a terminal, reads a plain line. */
function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY) return ask(question);
  stdout.write(`  ${question} `);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function choose(question: string, options: string[]): Promise<number> {
  stdout.write(`  ${question}\n`);
  options.forEach((option, index) => stdout.write(`    ${index + 1}. ${option}\n`));
  for (;;) {
    const answer = Number((await ask(`Choose 1 to ${options.length}:`)).trim());
    if (Number.isInteger(answer) && answer >= 1 && answer <= options.length) return answer - 1;
  }
}

async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await ask(`${question} [y/N]`)).trim());
}

async function pause(message: string): Promise<void> {
  await ask(message);
}

export const terminalPrompts: Prompts = { ask, askSecret, choose, confirm, pause };
