import path from "node:path";
import { fileURLToPath } from "node:url";

// Works from both src/ (tsx) and dist/ (node): one level up is the repo/app root.
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC_DIR = path.join(ROOT_DIR, "public");
export const VIEWS_DIR = path.join(ROOT_DIR, "views");
