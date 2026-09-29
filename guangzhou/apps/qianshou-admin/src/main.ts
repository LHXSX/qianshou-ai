import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'

import { App } from '@/App'
import { router, redirectToLogin } from '@/router'
import { onUnauthorized } from '@/api/client'
import { clearSession } from '@/session/store'
import '@/styles/base.css'

// 契约要求：401 一律跳登录页。API 层只管上报，跳转与清理在这里接线，
// 因此 `src/api/**` 不依赖 vue-router，可在测试里单独构造请求。
onUnauthorized(() => {
  clearSession()
  void redirectToLogin('expired')
})

const app = createApp(App)
app.use(ElementPlus, { locale: zhCn })
app.use(router)
app.mount('#app')
