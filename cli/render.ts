export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
export function printLine(msg: string): void {
  process.stdout.write(msg + "\n");
}
