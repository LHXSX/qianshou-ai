/**
 * 「接下来可以问什么」——按**当前这一句**算出来，而不是写死示例。
 *
 * 之前界面上挂的是 `FOLLOWUPS` 里固定的三条（特斯拉、比亚迪、PPT 大纲），
 * 用户问什么都显示那三条，跟话题完全无关；而且点了只把文字填进输入框，不会发出去。
 * 这里换成：从最近一轮问答里取出真正在谈的词，套上追问的语气生成三条。
 *
 * 为什么是本地派生而不是再叫一次模型：追问是**贴在手边**的快捷入口，必须立刻出来，
 * 不能为了三条建议再等一次网络往返、多花一次钱，也不能因为没配密钥就整块消失。
 * 派生失败时给的是通用追问——少一点贴题，但绝不跑题到别的行业去。
 *
 * 这个模块只做纯字符串处理：不碰 DOM、不发请求、不读存储，因此可以直接单测。
 */

/** 一条追问：`text` 会作为一条正式的用户消息发出去，所以必须自己就是一句完整的话。 */
export interface FollowUp {
  readonly text: string
  /** 屏幕上的短标签；过长时按字符截断，所以这里只负责短，不负责省略号。 */
  readonly label: string
}

/** 只按汉字数选词，所以常见动词也一并停掉——它们几乎不会是话题。 */
const VERB_WORDS: readonly string[] = [
  '帮忙', '麻烦', '告诉', '看看', '说说', '了解', '介绍', '展示', '安排',
  '弄个', '弄一', '做个', '写下', '写成', '写一', '整理', '总结', '规划', '评估',
]

/** 太泛、单独拿出来不成话题的双字词。 */
const STOP_BIGRAMS: readonly string[] = [
  '这个', '那个', '这些', '那些', '这里', '那里', '什么', '怎么', '怎样', '如何',
  '哪些', '哪个', '是否', '请问', '帮忙', '一下', '一些', '有点', '的话', '还是',
  '就是', '然后', '现在', '最近', '今天', '刚才', '关于', '对于', '以及', '而且',
  '但是', '因为', '所以', '如果', '已经', '没有', '不是', '一个', '问题', '情况',
  '时候', '地方', '内容', '多少', '你好', '谢谢', '多谢', '老板', '东西', '事情',
  '方面', '我们', '你们', '他们', '咱们',
]

/**
 * 能当话题的实词，按领域分层。
 *
 * 这张表是**有意的**：中文没有空格，靠规则切词的准确率达不到"追问必须贴话题"的要求，
 * 而一个中文对话产品真正会聊到的东西是可枚举的。表里没有的词就不猜——
 * 猜错行业比给通用追问更糟。
 */
const DOMAIN_TERMS: readonly string[] = [
  // 工作与业务
  '周报', '日报', '月报', '汇报', '总结', '复盘', '会议', '纪要', '排期', '计划',
  '流程', '规范', '制度', '模板', '清单', '方案', '策略', '预算', '成本', '报价',
  '合同', '条款', '风险', '合规', '客户', '用户', '需求', '反馈', '访谈', '问卷',
  '产品', '功能', '版本', '发布', '上线', '运营', '增长', '转化', '留存', '渠道',
  '市场', '行业', '竞品', '定价', '广告', '品牌', '推广', '销售', '订单', '库存',
  '财务', '发票', '报销', '对账', '税务', '工资', '数据', '指标', '报表', '趋势',
  '电商', '跨境', '物流', '仓储', '供应链', '采购', '投标', '路演', '入职', '考核',
  '租房', '保险', '贷款', '股票', '基金', '养老', '升学', '留学',
  // 技术与工程
  '代码', '接口', '架构', '数据库', '缓存', '部署', '测试', '日志', '性能', '安全',
  '模型', '算法', '训练', '推理', '智能体', '专家', '提示词', '服务器', '节点', '脚本',
  '文本', '图片', '视频', '音频', '文档', '表格', '邮件', '文件', '导出', '导入',
  // 生活与其他
  '旅行', '行程', '翻译', '学习', '考试', '健康', '饮食', '运动', '装修', '理财',
]

/** 黑名单的并集：进过这里就当噪声。 */
const STOP_WORDS: readonly string[] = [...VERB_WORDS, ...STOP_BIGRAMS]

/** 基本不携带话题的单字：助词、介词、代词、数词、量词、语气词。 */
const CHAR_STOP = '的了和与及或在是着过把被给让使很太更最也都还又就才只必须得各种个点位些呢吧啊呀哦嗯我你他她它咱您请帮做写弄用要会能好对再没不这那哪什么怎咋呢吗之其此该等依次第一二三两半多少大小上下前后里外中左右'

/** 拉丁整词、数字、连续假名：按整块收，不切碎。 */
const LATIN_OR_KANA = /[A-Za-z][A-Za-z0-9_+.#-]*|[\u3040-\u30ff]{2,}/g

/** 汉字长片段；两字以上的才可能是词。 */
const CJK_RUN = /[\u4e00-\u9fff]{2,}/g
/** 一个片段的长度上限：再长的东西几乎不可能是"一个词"，而是整句话。 */
const RUN_MAX = 4

/** 标签上限；手机上再长就把下面那行挤没了。 */
const LABEL_MAX = 16

/** 关键词上限；三条追问加起来也用不到更多。 */
const KEYWORD_MAX = 3

/** 是不是汉字。 */
const isCjk = (ch: string): boolean => ch >= '\u4e00' && ch <= '\u9fff'

/**
 * 抽关键词。中文没有空格，所以按「双字定词」处理：在每个汉字片段上切双字，
 * 剔除停用词与含虚字的组合，剩下的按**先出现**排。
 *
 * 长度上限（`RUN_MAX`）是这里最关键的一条：整句话也是"一个片段"，以前会整段收进来，
 * 于是追问里出现「展开说说请给我一份结构化的说明的具体情况」，界面只能靠省略号硬切。
 * 中文的实词很少超过四个字，超过就不是词了。
 * @param text - 用户的原话。
 * @returns 去重后的关键词，最多 `KEYWORD_MAX` 个。
 */
export function extractKeywords(text: string): readonly string[] {
  const found: { readonly index: number; readonly word: string }[] = []
  const lower = text.toLowerCase()

  // 拉丁词、版本号、产品名：整体就是一个词，取到就够用。
  for (const match of text.matchAll(LATIN_OR_KANA)) {
    const word = match[0]
    if (/^[0-9]+$/.test(word) || word.length < 2) continue
    found.push({ index: match.index ?? 0, word })
  }

  // 汉字词按表匹配。中文没有词边界，无表切词的准确率撑不起"要贴话题"这条要求，
  // 而**这个产品实际会聊到的东西是能列举的**——所以这里用一张按领域分层的表，
  // 宁可一个词都不猜，也不要猜出一个别的行业的词。
  for (const word of DOMAIN_TERMS) {
    const index = lower.indexOf(word)
    if (index >= 0) found.push({ index, word })
  }

  return found
    .sort((a, b) => a.index - b.index)
    .slice(0, KEYWORD_MAX)
    .map(item => item.word)
}

/**
 * 问句是「是不是」型还是「怎么做」型，决定追问该问结论还是问方法。
 * @param text - 用户的原话。
 * @returns 是非问句返回 `true`。
 */
export function isYesNoQuestion(text: string): boolean {
  const tail = text.trim().replace(/[。！？!?.…\s]+$/, '')
  return /(吗|么|嘛)$/.test(tail) || /是否/.test(tail)
}

/**
 * 主体是不是「一件事」而不是「一个东西」。
 * 问流程、问做法时，「帮我做这件事」比「它有什么风险」更接得上。
 * @param text - 用户的原话。
 * @returns 像在问做法返回 `true`。
 */
export function asksHowTo(text: string): boolean {
  return /(怎么|怎样|如何|咋|步骤|流程|方法|教程|教我)/.test(text)
}

/** 屏幕上能放下的标签。 */
function shortLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= LABEL_MAX) return flat
  return `${flat.slice(0, LABEL_MAX - 1)}…`
}

/**
 * 算出这一轮之后的追问。
 * @param question - 用户最近一次说的话；空字符串表示这轮没有用户输入（例如遥控投递）。
 * @returns 二到三条，屏幕直接照着渲染；永不返回空数组。
 */
export function deriveFollowUps(question: string): readonly FollowUp[] {
  const topic = extractKeywords(question)[0]
  const yesNo = isYesNoQuestion(question)
  const howTo = asksHowTo(question)

  if (topic === undefined) {
    // 没抽到话题（「你好」「谢谢」这类）：给不跑题的通用追问，别硬编一个行业出来。
    return [
      { text: '详细展开讲讲', label: '详细展开讲讲' },
      { text: '能举个例子吗？', label: '举个例子' },
      { text: '再说得简单一点', label: '说简单点' },
    ]
  }

  // 句子本身就要短到能当标签用：靠省略号硬切出来的「展开说说请给我一份结构…」
  // 既看不出要问什么，也占了两倍宽度。
  const texts = yesNo || !howTo
    ? [
      `展开讲讲${topic}的具体情况`,
      `${topic}这件事要注意什么？`,
      `把${topic}的要点列成清单`,
    ]
    : [
      `把${topic}整理成步骤`,
      `${topic}容易踩哪些坑？`,
      `围绕${topic}列个清单`,
    ]

  return texts.map(text => ({ text, label: shortLabel(text) }))
}
