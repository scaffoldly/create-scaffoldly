import fs from "fs";
import os from "os";
import path from "path";
import AdmZip from "adm-zip";
import minimist from "minimist";
import prompts from "prompts";
import { blue, red, reset, yellow } from "kolorist";
import axios from "axios";
import { parse, stringify } from "comment-json";
import simpleGit from "simple-git";

// Avoids autoconversion to number of the project name by defining that the args
// non associated with an option ( _ ) needs to be parsed as a string. See #4606
const argv = minimist<{
  t?: string;
  template?: string;
}>(process.argv.slice(2), { string: ["_"] });
const cwd = process.cwd();

type ColorFunc = (str: string | number) => string;
type Framework = {
  repo: string;
  display: string;
  color: ColorFunc;
  variants: FrameworkVariant[];
  downloadUrl: string;
  startCommand: string;
};
type FrameworkVariant = {
  branch: string;
  display: string;
  color: ColorFunc;
};
type Choice = {
  projectName: string;
  framework: Framework;
  variant: string;
  overwrite?: "yes";
  packageName: string;
};

const FRAMEWORKS: Framework[] = [
  {
    display: "Serverless + Express on AWS",
    downloadUrl: "https://codeload.github.com/scaffoldly",
    repo: "stack-aws-serverless-express",
    color: yellow,
    startCommand: "yarn dev",
    variants: [
      {
        branch: "headless",
        display: "Backend API (No Frontend)",
        color: blue,
      },
      {
        branch: "react-vite",
        display: "Backend API + React Frontend (w/Vite)",
        color: blue,
      },
      {
        branch: "angular",
        display: "Backend API + Angular Frontend",
        color: blue,
      },
    ],
  },
];

const TEMPLATES = FRAMEWORKS.map(
  (f) => (f.variants && f.variants.map((v) => v.branch)) || [f.repo]
).reduce((a, b) => a.concat(b), []);

const renameFiles: Record<string, string | undefined> = {
  _gitignore: ".gitignore",
};

const defaultTargetDir = "my-app";

async function init() {
  const argTargetDir = formatTargetDir(argv._[0]);
  const argTemplate = argv.template || argv.t;

  let targetDir = argTargetDir || defaultTargetDir;
  const getProjectName = () =>
    targetDir === "." ? path.basename(path.resolve()) : targetDir;

  let result: prompts.Answers<
    "projectName" | "overwrite" | "packageName" | "framework" | "variant"
  >;

  prompts.override({
    overwrite: argv.overwrite,
  });

  try {
    result = await prompts(
      [
        {
          type: argTargetDir ? null : "text",
          name: "projectName",
          message: reset("Project name:"),
          initial: defaultTargetDir,
          onState: (state) => {
            targetDir = formatTargetDir(state.value) || defaultTargetDir;
          },
        },
        {
          type: () =>
            !fs.existsSync(targetDir) || isEmpty(targetDir) ? null : "select",
          name: "overwrite",
          message: () =>
            (targetDir === "."
              ? "Current directory"
              : `Target directory "${targetDir}"`) +
            ` is not empty. Please choose how to proceed:`,
          initial: 0,
          choices: [
            {
              title: "Remove existing files and continue",
              value: "yes",
            },
            {
              title: "Cancel operation",
              value: "no",
            },
            {
              title: "Ignore files and continue",
              value: "ignore",
            },
          ],
        },
        {
          type: (_, { overwrite }: { overwrite?: string }) => {
            if (overwrite === "no") {
              throw new Error(red("✖") + " Operation cancelled");
            }
            return null;
          },
          name: "overwriteChecker",
        },
        {
          type: () => (isValidPackageName(getProjectName()) ? null : "text"),
          name: "packageName",
          message: reset("Package name:"),
          initial: () => toValidPackageName(getProjectName()),
          validate: (dir) =>
            isValidPackageName(dir) || "Invalid package.json name",
        },
        {
          type:
            argTemplate && TEMPLATES.includes(argTemplate) ? null : "select",
          name: "framework",
          message:
            typeof argTemplate === "string" && !TEMPLATES.includes(argTemplate)
              ? reset(
                  `"${argTemplate}" isn't a valid template. Please choose from below: `
                )
              : reset("Select a framework:"),
          initial: 0,
          choices: FRAMEWORKS.map((framework) => {
            const frameworkColor = framework.color;
            return {
              title: frameworkColor(framework.display || framework.repo),
              value: framework,
            };
          }),
        },
        {
          type: (framework: Framework) =>
            framework && framework.variants ? "select" : null,
          name: "variant",
          message: reset("Select a variant:"),
          choices: (framework: Framework) =>
            framework.variants.map((variant) => {
              const variantColor = variant.color;
              return {
                title: variantColor(variant.display || variant.branch),
                value: variant.branch,
              };
            }),
        },
      ],
      {
        onCancel: () => {
          throw new Error(red("✖") + " Operation cancelled");
        },
      }
    );
  } catch (cancelled: any) {
    console.log(cancelled.message);
    return;
  }

  // user choice associated with prompts
  const {
    framework,
    overwrite,
    packageName,
    variant: branch,
  } = result as Choice;

  const root = path.join(cwd, targetDir);

  if (overwrite === "yes") {
    emptyDir(root);
  } else if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }

  console.log(`\nScaffolding project in ${root}...`);

  const templateDir = await downloadAndExtractZip(framework, branch);

  const write = (file: string, content?: string) => {
    const targetPath = path.join(root, renameFiles[file] ?? file);
    if (content) {
      fs.writeFileSync(targetPath, content);
    } else {
      copy(path.join(templateDir, file), targetPath);
    }
  };

  const files = fs.readdirSync(templateDir);
  for (const file of files.filter(
    (f) =>
      f !== "README.md" &&
      f !== "package.json" &&
      f !== "yarn.lock" &&
      f !== "package-lock.json" &&
      f !== "TODO.md"
  )) {
    write(file);
  }

  // TODO: Generate README
  // TODO: Git init and change branch name to "development"

  const pkg = parse(
    fs.readFileSync(path.join(templateDir, `package.json`), "utf-8")
  ) as any;

  const devcontainer = parse(
    fs.readFileSync(
      path.join(templateDir, `.devcontainer/devcontainer.json`),
      "utf-8"
    )
  ) as any;

  pkg.name = packageName || getProjectName();
  devcontainer.name = pkg.name;
  delete pkg.description;
  delete pkg.license;

  write("package.json", stringify(pkg, null, 2) + "\n");
  write(".devcontainer/devcontainer.json", stringify(devcontainer, null, 2));

  console.log(`Initializing git in ${root}...`);
  const git = simpleGit(root);
  await git.init({ "--initial-branch": "development" });
  await git.add(".");
  await git.commit("Initial commit");

  const cdProjectName = path.relative(cwd, root);
  console.log(`\nDone.\n`);
  if (root !== cwd) {
    console.log(
      `    cd ${
        cdProjectName.includes(" ") ? `"${cdProjectName}"` : cdProjectName
      }`
    );
  }

  console.log(`    ${framework.startCommand}\n`);
  console.log(`Which will launch a devcontainer on your local machine.\n`);

  console.log(
    `Alternatively, push this repository to GitHub to develop in GitHub Codespaces:\n`
  );
  console.log(`    1) Create a new repository on GitHub`);
  console.log(`    2) git remote add origin <repository-url>`);
  console.log(`    3) git push -u origin development`);
  console.log(`    4) Open in GitHub Codespaces\n`);

  console.log(`Once you're ready to deploy to AWS, run:\n`);
  console.log(`    npx slydo deploy\n`);

  console.log(`\n🚀 Thanks for using Scaffoldly!\n\n`);
  // TODO DOCS URL
}

function formatTargetDir(targetDir: string | undefined) {
  return targetDir?.trim().replace(/\/+$/g, "");
}

function copy(src: string, dest: string) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    copyDir(src, dest);
  } else {
    fs.copyFileSync(src, dest);
  }
}

function isValidPackageName(projectName: string) {
  return /^(?:@[a-z\d\-*~][a-z\d\-*._~]*\/)?[a-z\d\-~][a-z\d\-._~]*$/.test(
    projectName
  );
}

function toValidPackageName(projectName: string) {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^[._]/, "")
    .replace(/[^a-z\d\-~]+/g, "-");
}

function copyDir(srcDir: string, destDir: string) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    const srcFile = path.resolve(srcDir, file);
    const destFile = path.resolve(destDir, file);
    copy(srcFile, destFile);
  }
}

function isEmpty(path: string) {
  const files = fs.readdirSync(path);
  return files.length === 0 || (files.length === 1 && files[0] === ".git");
}

function emptyDir(dir: string) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const file of fs.readdirSync(dir)) {
    if (file === ".git") {
      continue;
    }
    fs.rmSync(path.resolve(dir, file), { recursive: true, force: true });
  }
}

async function downloadAndExtractZip(
  framework: Framework,
  branch: string
): Promise<string> {
  const { downloadUrl, repo } = framework;

  const url = new URL(`${downloadUrl}/${repo}/zip/refs/heads/${branch}`);

  try {
    const response = await axios({
      method: "get",
      url: url.toString(),
      responseType: "arraybuffer",
    });

    const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "template-"));
    const tempFileName = url.pathname.split("/").pop();

    const tempZipPath = path.join(tempDirPath, tempFileName!);
    fs.writeFileSync(tempZipPath, response.data);

    const zip = new AdmZip(tempZipPath);
    zip.extractAllTo(tempDirPath, true);

    fs.unlinkSync(tempZipPath);

    return path.join(tempDirPath, `${repo}-${branch}`);
  } catch (error) {
    throw new Error(`Error downloading or extracting ZIP file: ${error}`);
  }
}

init().catch((e) => {
  console.error(e);
});
