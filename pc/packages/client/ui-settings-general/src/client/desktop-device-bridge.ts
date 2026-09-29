/** The optional, Electron-owned device preference carrier. */
export interface DesktopDevicePreferences {
  readonly launchAtLogin: boolean
  readonly launchAtLoginAvailable: boolean
  readonly keepAwake: boolean
  readonly automaticUpdates?: boolean
}

/** Only the owned desktop document can call these main-process actions. */
export interface DesktopDeviceBridge {
  status(): Promise<DesktopDevicePreferences>
  set(name: 'launchAtLogin' | 'keepAwake' | 'automaticUpdates', enabled: boolean): Promise<DesktopDevicePreferences>
}
