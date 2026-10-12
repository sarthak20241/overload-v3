/**
 * The probe scripts write a made-up person to the LIVE database and delete it
 * at the end. A thrown error (a failed `must()`) would skip that last step and
 * leave the person behind, where the daily facts job would keep rebuilding it.
 * This runs the script's own cleanup first, then exits non-zero.
 */
export function cleanupOnCrash(cleanup: () => Promise<unknown>): void {
  let running = false;
  const onCrash = async (err: unknown) => {
    if (running) return;
    running = true;
    console.error(err);
    try {
      await cleanup();
      console.error('cleaned up the probe person after the error');
    } catch (e) {
      console.error('cleanup after the error failed too:', e);
    }
    process.exit(1);
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
}
