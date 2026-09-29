/** The signed platform bucket identifies one COS virtual host; never trust a wildcard domain. */
export function trustedOrderArchiveHostname(configured: string, bucket: unknown): string {
  if (configured !== '') return configured
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{2,52}-[0-9]{10}$/u.test(bucket)) return ''
  return `${bucket}.cos.ap-shanghai.myqcloud.com`
}
