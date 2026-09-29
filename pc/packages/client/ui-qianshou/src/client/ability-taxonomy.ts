/** Content subdivisions classify existing catalog metadata without changing dispatch. */
import type { QianshouKey } from './locales.ts'
import type { SkillCategory } from './SkillSeat.tsx'

interface AbilitySubdivision {
  readonly id: string
  readonly key: QianshouKey
  readonly pattern: RegExp
}

const SUBDIVISIONS: Partial<Record<SkillCategory, readonly AbilitySubdivision[]>> = {
  text: [
    { id: 'statistics', key: 'abilitySubTextStatistics', pattern: /count|frequen|统计|计数|词频|字数|字符数/iu },
    { id: 'conversion', key: 'abilitySubTextConversion', pattern: /convert|translat|encod|转换|翻译|编码|格式/iu },
    { id: 'writing', key: 'abilitySubTextWriting', pattern: /writ|rewrite|doc|report|article|写作|文案|文档|报告|改写/iu },
  ],
  image: [
    { id: 'recognition', key: 'abilitySubImageRecognition', pattern: /ocr|recogn|vision|识别|读图|视觉分析/iu },
    { id: 'processing', key: 'abilitySubImageProcessing', pattern: /edit|process|resize|crop|upscal|处理|编辑|抠图|裁剪|超分/iu },
    { id: 'generation', key: 'abilitySubImageGeneration', pattern: /generat|imagegen|illustrat|生成|出图|绘图|插画/iu },
  ],
  video: [
    { id: 'animation', key: 'abilitySubVideoAnimation', pattern: /svg|gif|animat|motion|动画|动图|动效/iu },
    { id: 'editing', key: 'abilitySubVideoEditing', pattern: /edit|clip|剪辑|剪切|拼接/iu },
    { id: 'production', key: 'abilitySubVideoProduction', pattern: /generat|synth|create|制作|生成|合成/iu },
  ],
  development: [
    { id: 'review', key: 'abilitySubDevelopmentReview', pattern: /review|test|debug|检查|测试|审查|调试/iu },
    { id: 'delivery', key: 'abilitySubDevelopmentDelivery', pattern: /deploy|repo|git|publish|部署|仓库|发布/iu },
    { id: 'coding', key: 'abilitySubDevelopmentCoding', pattern: /code|sdk|plugin|hook|编程|代码|插件|钩子/iu },
  ],
  ppt: [
    { id: 'design', key: 'abilitySubPptDesign', pattern: /design|template|layout|设计|模板|排版/iu },
    { id: 'production', key: 'abilitySubPptProduction', pattern: /ppt|slide|presentation|演示|幻灯|制作/iu },
  ],
  spreadsheet: [
    { id: 'calculation', key: 'abilitySubDataCalculation', pattern: /formula|calcul|公式|计算/iu },
    { id: 'processing', key: 'abilitySubDataProcessing', pattern: /spreadsheet|excel|xlsx|csv|表格|处理|清洗/iu },
  ],
  data: [
    { id: 'calculation', key: 'abilitySubDataCalculation', pattern: /calcul|count|compute|计算|计数|统计/iu },
    { id: 'visualization', key: 'abilitySubDataVisualization', pattern: /chart|visual|plot|图表|可视化/iu },
    { id: 'processing', key: 'abilitySubDataProcessing', pattern: /process|clean|transform|处理|清洗|转换/iu },
  ],
  research: [{ id: 'research', key: 'abilitySubResearch', pattern: /research|search|browse|调研|搜索|检索|核对/iu }],
  automation: [{ id: 'automation', key: 'abilitySubAutomation', pattern: /automat|schedule|remind|workflow|定时|提醒|自动化|工作流/iu }],
  design: [{ id: 'design', key: 'abilitySubDesign', pattern: /design|layout|canvas|template|设计|排版|画布|模板/iu }],
}

/** Pick the first matching subdivision, retaining unmatched catalog entries under Other.
 * @param category - The already established primary content category.
 * @param name - The catalog name or local skill identifier.
 * @param description - The authored capability description.
 * @returns A stable subdivision id and its locale key.
 */
export function abilitySubdivision(category: SkillCategory, name: string, description: string): { id: string; key: QianshouKey } {
  const match = SUBDIVISIONS[category]?.find(item => item.pattern.test(`${name} ${description}`))
  return match === undefined ? { id: 'other', key: 'skillCategoryOther' } : { id: match.id, key: match.key }
}
