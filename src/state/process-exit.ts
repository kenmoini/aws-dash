/** Injectable so the crash control can be tested without killing the test runner. */
export type ProcessExit = (code: number) => void;

export const realExit: ProcessExit = (code) => process.exit(code);
