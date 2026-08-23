/**
 * The Apps Script bundle, inlined at build time.
 *
 * A virtual module rather than a plain import because `apps/apps-script/dist/`
 * is a build artifact and is not committed: a clean clone has no file to
 * import, and a missing import is a build failure rather than a missing
 * feature. The plugin substitutes an instruction to run the build instead, so
 * the app always builds and the wizard always says something useful.
 */
declare module 'virtual:apps-script-source' {
  const source: string;
  export default source;
}
