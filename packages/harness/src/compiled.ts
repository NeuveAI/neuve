/** Whether this process runs a compiled Bun executable, installed or built in a checkout. */
export const isCompiled = () => Bun.main.startsWith("/$bunfs/");
