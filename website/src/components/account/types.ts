export interface AccountProfileForm {
  username: string
  displayName: string
  phone: string
  language: string
  country: string
}

export interface PasswordForm {
  old: string
  new: string
  confirm: string
}

export interface NotificationPreferences {
  notifyOffline: boolean
  dailyReport: boolean
  notifyFailed: boolean
  systemNotice: boolean
}

export type AccountProfileField = keyof AccountProfileForm
export type PasswordField = keyof PasswordForm
export type NotificationPreferenceField = keyof NotificationPreferences
