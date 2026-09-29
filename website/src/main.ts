import { createApp } from "vue";
import { createPinia } from "pinia";

// Account controls load with their route, so the public homepage stays small.
import "./shared/design-system.css";

import App from "./App.vue";
import router from "./router";

const app = createApp(App);

app.use(createPinia());
app.use(router);

app.mount("#app");
