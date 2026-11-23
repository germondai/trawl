export function fixtureChildEnv(): Record<string, string | undefined> {
  const env = process.env
  if (process.platform !== "win32") return { PATH: env.PATH }
  return {
    PATH: env.PATH,
    SystemRoot: env.SystemRoot,
    WINDIR: env.WINDIR,
    TEMP: env.TEMP,
    TMP: env.TMP,
    USERPROFILE: env.USERPROFILE,
    LOCALAPPDATA: env.LOCALAPPDATA,
    APPDATA: env.APPDATA,
  }
}
