"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.exec = void 0;
const child_process_1 = __importDefault(require("child_process"));
const console_1 = require("console");
const which_1 = __importDefault(require("which"));
const exec = (workingDirectory, argv) => {
    return new Promise(async (resolve, reject) => {
        const env = {
            ...process.env,
        };
        let command;
        try {
            command = which_1.default.sync(argv[0]);
        }
        catch (e) {
            reject(new Error(`Unable to locate the \`${argv[0]}\` command on this system.`));
            return;
        }
        const p = child_process_1.default.spawn(`"${command}"`, argv.slice(1), {
            cwd: workingDirectory,
            shell: true,
            env,
        });
        p.on("error", (err) => {
            (0, console_1.error)(err);
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
exports.exec = exec;
