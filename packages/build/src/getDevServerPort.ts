export const getDevServerPort = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  return env.PORT || '3000'
}
