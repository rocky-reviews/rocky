// Run by deploy/smoke.sh inside a running app container (`node --input-type=module <
// smoke-probe.mjs`): proves the read-only root filesystem and the non-root user from the
// process's own point of view. Exit 0 when every check holds; 1 with the failing checks' names
// otherwise. Nothing else is printed.
import { rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const failures = [];
const check = (name, ok) => {
  if (!ok) failures.push(name);
};

check("uid is 65532", process.getuid() === 65532);
check("gid is 65532", process.getgid() === 65532);

const writeFails = (path) => {
  try {
    writeFileSync(path, "probe");
    rmSync(path, { force: true });
    return false;
  } catch (error) {
    return error.code === "EROFS" || error.code === "EACCES" || error.code === "EPERM";
  }
};
// The code, the system directories, the home and the root: all must refuse a write.
for (const path of [
  "/app/probe",
  "/app/healthcheck.mjs",
  "/etc/probe",
  "/home/nonroot/probe",
  "/probe",
]) {
  check(`write to ${path} fails`, writeFails(path));
}
// Deleting or replacing the code must fail too (the files are root's on a read-only mount).
try {
  unlinkSync("/app/healthcheck.mjs");
  check("unlink of the code fails", false);
} catch (error) {
  check("unlink of the code fails with EROFS", error.code === "EROFS");
}
// A tmpfs is present only when the service mounts one (the worker's heartbeat); when it is,
// it must be a separate mount, not a writable spot on the root filesystem.
if (!writeFails("/tmp/probe")) {
  check("/tmp is a separate mount", statSync("/tmp").dev !== statSync("/").dev);
}

if (failures.length > 0) {
  process.stderr.write(`probe failed: ${failures.join("; ")}\n`);
  process.exit(1);
}
