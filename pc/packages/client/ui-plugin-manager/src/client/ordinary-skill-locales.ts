/** Copy for ordinary skill publication and independently reviewed listings. */
export const en = { title: 'Publish a skill', local: 'Local skill', choose: 'Choose an existing skill', name: 'Name',
  summary: 'Description', price: 'Price (CNY)', submit: 'Submit for staff review', reload: 'Refresh skills', refresh: 'Query original submission',
  instructions: 'Submit the selected skill snapshot and your price once. Staff download and test these exact bytes before listing.',
  submitting: 'Submitting the selected snapshot…', unknown: 'The submission response is uncertain. Query the original request; the package will not be sent again.',
  submitted: 'Submission received', pending: 'Awaiting staff download and manual testing', published: 'Manually tested and listed',
  rejected: 'Staff declined this submission', failed: 'Unable to read the skill service. Your input is retained.',
  market: 'Reviewed skills', loading: 'Reading the skill directory…', empty: 'No reviewed ordinary skills are currently listed.',
  official: 'Official', user: 'User published', unavailable: 'Purchasing is not yet available', receipt: 'Manual review receipt',
  package: 'Package SHA-256', requests: 'My submissions', noLocal: 'No publishable local skills were found.', signIn: 'Sign in to submit a skill.' } as const
export type OrdinarySkillKey = keyof typeof en
export const zh: Record<OrdinarySkillKey, string> = { title: '发布技能', local: '本机技能', choose: '选择本机已有技能', name: '名称',
  summary: '简介', price: '售价（元）', submit: '明确提交人工审核', reload: '刷新本机技能', refresh: '查询原投稿',
  instructions: '一次提交所选技能快照与售价。工作人员拉取并人工测试这些确切文件后，再决定上架。',
  submitting: '正在提交所选技能快照…', unknown: '提交响应待确认。请查询原投稿，不会重复发送技能包。',
  submitted: '已收到投稿', pending: '等待工作人员拉取与人工测试', published: '已人工测试并上架',
  rejected: '本次投稿未通过人工审核', failed: '暂时无法读取技能服务，已保留输入。',
  market: '已审核技能', loading: '正在读取技能目录…', empty: '当前没有已上架的普通技能。',
  official: '官方', user: '用户发布', unavailable: '尚未开放购买', receipt: '人工审核回执',
  package: '技能包 SHA-256', requests: '我的投稿', noLocal: '未找到可投稿的本机技能。', signIn: '登录后可提交技能。' }
