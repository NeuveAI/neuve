import { resolve } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

const sessionVariables = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "NEUVE_REPOSITORY",
  "NEUVE_HOST_URL",
  "NEUVE_HOST_TOKEN_FILE",
] as const;

export const webEnvironment = (environment: Environment) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value !== undefined && sessionVariables.some((name) => name === key),
    ),
  );

/** The loopback Vite/BFF command for developing the web app. */
export const webCommand = (options: {
  root: string;
  executable?: string;
  port: number;
  environment: Environment;
}) => ({
  command: [
    options.executable ?? process.execPath,
    "--no-env-file",
    "--bun",
    "vite",
    "dev",
    "--port",
    String(options.port),
    "--host",
    "127.0.0.1",
    "--strictPort",
  ],
  cwd: resolve(options.root, "apps/neuve-web/apps/web"),
  env: webEnvironment(options.environment),
});
