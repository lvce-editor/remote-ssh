export const getDevServerPort = (env = process.env) => {
  return env.PORT || '3000'
}
