import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A temp directory standing in for "/" so /proc, /sys and /etc can be faked. */
export class FakeRoot {
  readonly path = fs.mkdtempSync(path.join(os.tmpdir(), "aws-dash-root-"));

  write(relative: string, content: string, mode?: number): this {
    const full = path.join(this.path, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (mode !== undefined) fs.chmodSync(full, mode);
    return this;
  }

  dir(relative: string): this {
    fs.mkdirSync(path.join(this.path, relative), { recursive: true });
    return this;
  }

  cleanup(): void {
    fs.rmSync(this.path, { recursive: true, force: true });
  }
}
