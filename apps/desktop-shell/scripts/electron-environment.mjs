export function desktopElectronEnvironment(source) {
  const output = Object.create(null);
  for (const [name, value] of Object.entries(source)) {
    if (/^(?:ELECTRON_|NODE_|DOTNET_|COMPLUS_|CORECLR_)/iu.test(name)) continue;
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(name)) continue;
    if (typeof value === "string") output[name] = value;
  }
  output.NODE_ENV = "production";
  return output;
}
