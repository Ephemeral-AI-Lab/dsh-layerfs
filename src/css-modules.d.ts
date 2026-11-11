declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
declare module '*.svg' {
  const svg: string
  export default svg
}
