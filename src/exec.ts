import proc from "child_process";
import { error } from "console";
import which from "which";

export const exec = (
  workingDirectory: string,
  argv: string[]
): Promise<void> => {
  return new Promise<void>(async (resolve, reject) => {
    const env = {
      ...process.env,
    };

    let command: string;
    try {
      command = which.sync(argv[0]);
    } catch (e) {
      reject(
        new Error(`Unable to locate the \`${argv[0]}\` command on this system.`)
      );
      return;
    }

    const p = proc.spawn(`"${command}"`, argv.slice(1), {
      cwd: workingDirectory,
      shell: true,
      env,
    });

    p.on("error", (err) => {
      error(err);
      reject(err);
    });

    p.on("exit", () => {
      resolve();
    });

    p.stdin.pipe(process.stdin);
    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stderr);
  });
};
