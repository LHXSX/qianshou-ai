import { defineComponent, h } from 'vue'
import { RouterView } from 'vue-router'

/**
 * 根组件：只负责挂载路由出口。
 * 布局（侧栏/顶栏）在 `components/AppLayout.vue`，登录页不套布局。
 */
export const App = defineComponent({
  name: 'QianshouAdminApp',
  setup() {
    return () => h(RouterView)
  },
})
