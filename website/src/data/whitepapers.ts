export interface Whitepaper {
  id: string;
  title: string;
  desc: string;
  icon: string;
  category: string;
  href?: string;
  external?: boolean;
}

export interface WhitepaperGroup {
  id: string;
  title: string;
  desc: string;
}

export const whitepaperGroups: WhitepaperGroup[] = [
  { id: 'landing', title: '官方入口', desc: '官网、下载、登录与企业入口' },
  { id: 'docs', title: '核心资料', desc: '统一保留的项目主文档' },
];

export const whitepapers: Whitepaper[] = [
  { id: 'home', title: '官网首页', desc: '千手算力 · 分布式边缘算力网络', icon: '🏠', category: 'landing', href: '/' },
  { id: 'beta', title: '企业合作咨询', desc: '提交场景，了解可用能力与试跑条件', icon: '🌱', category: 'landing', href: '/beta' },
  { id: 'login', title: '个人登录', desc: '使用千手账号进入工作台', icon: '👤', category: 'landing', href: '/login' },
  { id: 'register', title: '个人注册', desc: '注册新账号', icon: '📝', category: 'landing', href: '/register' },
  { id: 'downloads', title: '下载中心', desc: '客户端下载', icon: '⬇️', category: 'landing', external: true, href: '/#/downloads-center' },
  { id: 'enterprise-portal', title: '企业端入口', desc: '企业控制台', icon: '🏢', category: 'landing', external: true, href: '/wq/#/login' },
  { id: 'admin-portal', title: '管理端入口', desc: '管理后台', icon: '🛡️', category: 'landing', external: true, href: '/admin/#/login' },

  { id: 'whitepaper-master', title: '总白皮书', desc: '完整项目白皮书', icon: '📄', category: 'docs', href: '/whitepaper-master' },
];

export function getWhitepaper(slug: string): Whitepaper | null {
  return whitepapers.find(d => d.id === slug) || null;
}
