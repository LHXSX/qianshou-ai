<template>
  <section id="usage" class="support-panel install-help">
    <p class="support-overline">安装与开始使用</p>
    <h2>跟着四步，进入你的工作空间</h2>
    <p>
      选择对应系统查看步骤。更新前先保存工作、妥善处理运行中的任务并退出旧客户端。
    </p>
    <div class="os-tabs" role="group" aria-label="安装步骤平台">
      <button :aria-pressed="platform === 'windows'" @click="select('windows')">
        Windows 安装步骤
      </button>
      <button :aria-pressed="platform === 'mac'" @click="select('mac')">
        Mac 安装步骤
      </button>
    </div>
    <ol class="install-steps">
      <li v-for="(step, i) in steps" :key="step.title">
        <span class="step-index">0{{ i + 1 }}</span>
        <h3>{{ step.title }}</h3>
        <p>{{ step.text }}</p>
      </li>
    </ol>
    <div class="macfix" id="mac-fix" v-show="platform === 'mac'">
      <div class="sh">
        <h2><span class="n">?</span> Mac 第一次打不开，怎么办？</h2>
        <p>先查看提示属于哪一种，再按下面操作。</p>
      </div>
      <div class="guide-card">
        <h3>提示「无法验证开发者」或「Apple 无法检查」</h3>
        <p>
          本预览版尚未完成 Apple
          开发者签名与公证。确认是从本页下载、且文件未被修改后：
        </p>
        <ol>
          <li>
            先到「应用程序」双击一次「千手生态 v3
            预览版」。出现提示后点「完成」或关闭提示。
          </li>
          <li>
            打开屏幕左上角 
            →「系统设置」→「隐私与安全性」，向下找到本应用的提示，点「仍要打开」。
          </li>
          <li>
            按系统要求验证身份，再点「打开」。以后从「应用程序」启动即可。
          </li>
        </ol>
        <p>
          <a
            href="https://support.apple.com/zh-cn/102445"
            target="_blank"
            rel="noopener noreferrer"
            >查看 Apple 官方图文说明 ↗</a
          >
          · 公司管理的 Mac 可能需要联系管理员。
        </p>
      </div>
      <div class="guide-card">
        <h3>提示「已损坏」，或打不开安装包</h3>
        <p>
          先删除这次下载的 DMG，从本页重新下载，并核对下方
          SHA-256。下载不完整、文件改动和签名问题都可能造成此提示，不能仅凭弹窗判断原因。校验不一致时请停止安装，重新下载或反馈。
        </p>
        <p>
          如果系统明确提示「将损坏电脑」或恶意软件，请停止打开并反馈，不执行下面的备用命令。
        </p>
        <details id="mac-advanced" open>
          <summary>备用方法：已核对官网来源及 SHA-256，仍无法打开</summary>
          <p>
            先将应用拖进「应用程序」，保持名称为「千手生态 v3
            预览版」。下面的命令只移除此应用的下载隔离标记；它不能修复损坏的文件，也不会更改系统全局安全设置。
          </p>
          <ol>
            <li>
              按键盘 <b>Command（⌘）+ 空格</b>，输入「终端」，按回车打开。
            </li>
            <li>
              点下方「复制命令」，回到终端按
              <b>Command（⌘）+ V</b> 粘贴，然后按回车。无需输入管理员密码。
            </li>
            <li>
              命令没有输出且没有报错通常表示完成。回到「应用程序」，双击本应用。
            </li>
          </ol>
          <div class="term">
            <div class="cmdrow">
              <span class="pr">$</span
              ><code id="macfix-app"
                >xattr -dr com.apple.quarantine "/Applications/千手生态 v3
                预览版.app"</code
              ><button class="cp" @click="copyCommand('macfix-app')">
                复制命令
              </button>
            </div>
          </div>
          <p>
            若提示「No such
            file」，检查是否已拖入「应用程序」以及名称是否一致；若提示「Permission
            denied」，请反馈或联系管理员，不要反复追加其他命令。
          </p>
        </details>
      </div>
    </div>

    <div class="macfix" id="windows-fix" v-show="platform === 'windows'">
      <div class="sh">
        <h2><span class="n">?</span> Windows 首次安装被拦截，怎么办？</h2>
        <p>
          当前预览版尚未取得 Microsoft Authenticode
          代码签名认证，可能出现未知发布者或 SmartScreen 提示。
        </p>
      </div>
      <div class="guide-card">
        <h3>提示「Windows 已保护你的电脑」</h3>
        <ol>
          <li>确认安装包来自本页，并核对下方 SHA-256。</li>
          <li>
            在 SmartScreen
            提示中点「更多信息」，确认是刚下载的安装包，再点「仍要运行」（如果系统提供此选项）。
          </li>
          <li>
            按安装向导继续。若出现用户账户控制提示，请核对程序和操作后决定是否允许。
          </li>
        </ol>
        <p>
          如果没有「仍要运行」，或设备由公司管理，请联系管理员。Smart App
          Control、组织策略及恶意软件拦截不一定允许手动继续；请勿关闭 Defender
          或系统保护。
        </p>
      </div>
      <div class="guide-card">
        <h3>文件属性提示「此文件来自其他计算机」</h3>
        <p>
          已确认来源和校验值后，可右键安装包
          →「属性」→「常规」，勾选「解除锁定」→「应用」。也可使用下面的
          PowerShell 命令处理同一个文件。
        </p>
        <ol>
          <li>在开始菜单搜索并打开「PowerShell」，无需以管理员身份运行。</li>
          <li>
            复制命令，把单引号中的占位路径替换为你实际下载的安装包完整路径，再回车。
          </li>
          <li>没有输出且没有报错通常表示完成；回到下载目录双击安装包。</li>
        </ol>
        <div class="term">
          <div class="cmdrow">
            <span class="pr">PS&gt;</span
            ><code id="winfix-file"
              >Unblock-File -LiteralPath
              'C:\实际下载目录\实际安装包文件名.exe'</code
            ><button class="cp" @click="copyCommand('winfix-file')">
              复制命令
            </button>
          </div>
        </div>
        <p>
          此命令只移除指定文件的下载来源标记，不会给软件签名，也不保证消除
          SmartScreen
          提示。若提示找不到路径，请检查完整路径；若提示恶意软件，请停止安装并反馈。
        </p>
        <p>
          <a
            href="https://learn.microsoft.com/zh-cn/powershell/module/microsoft.powershell.utility/unblock-file"
            target="_blank"
            rel="noopener noreferrer"
            >查看 Microsoft 命令说明 ↗</a
          >
        </p>
      </div>
    </div>

    <details id="checksums" :open="route.hash === '#checksums'">
      <summary>安装包 SHA-256 · 如何确认下载完整</summary>
      <p>
        Mac：打开“终端”，输入
        <code>shasum -a 256 </code>（末尾保留空格），将下载的 DMG
        拖入终端，再回车。
      </p>
      <p>Windows：在 PowerShell 使用下方命令，把占位路径换成实际安装包路径。</p>
      <div class="cmdrow">
        <code id="win-sha"
          >Get-FileHash -Algorithm SHA256 -LiteralPath
          'C:\实际下载目录\实际安装包文件名.exe'</code
        ><button class="support-text-button" @click="copyCommand('win-sha')">
          复制校验命令
        </button>
      </div>
      <p>
        把输出摘要与对应文件下方的 64
        位字符比较，字母大小写不影响结果。摘要一致说明文件完整，不代替系统安全验证。
      </p>
      <div
        v-for="file in release?.downloads"
        :key="file.platform"
        class="checksum-row"
      >
        <strong>{{
          file.platform === "windows-x64" ? "Windows x64" : "Mac Apple Silicon"
        }}</strong>
        <p>{{ file.url.split("/").pop() }}</p>
        <code>{{ file.sha256 }}</code>
      </div>
      <p v-if="!release">暂未取得官方校验值，请回到上方重新获取版本。</p>
    </details>
    <div class="support-callout">
      <p>
        Mac
        从旧版更新：若旧图标叫“千手生态v3预览版”（没有空格），新版可能与旧图标同时存在。请先退出旧版，以带空格的新名称启动；不要删除个人数据目录。
      </p>
    </div>
    <p>
      应用从客户端“生态商店”安装，在“我的应用”启动。无需为每款应用另外下载安装器。后续按客户端提示分别更新。
    </p>
    <p role="status" class="copy-feedback">{{ copyState }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { EcoRelease } from "../../services/releaseContract";
defineProps<{ release: EcoRelease | null }>();
const route = useRoute(),
  router = useRouter(),
  copyState = ref("");
const platform = computed(() =>
  route.hash === "#mac-fix"
    ? "mac"
    : route.hash === "#windows-fix"
      ? "windows"
      : route.query.platform === "mac"
        ? "mac"
        : route.query.platform === "windows"
          ? "windows"
          : /Mac/.test(navigator.userAgent)
            ? "mac"
            : "windows",
);
const windowsSteps = [
  {
    title: "下载 Windows 安装包",
    text: "选择 Windows 64 位（x64）版，下载 EXE。更新前退出正在运行的旧客户端。",
  },
  {
    title: "打开安装程序",
    text: "双击下载的 EXE，按向导安装。安装到原目录可更新旧版，无需先删除个人数据。仅在确认官网来源后继续系统提示。",
  },
  {
    title: "首次启动并登录",
    text: "启动“千手生态 v3 预览版”，使用已有生态账号登录。首次启动保持联网，按安装器提示完成所需组件安装。",
  },
  {
    title: "从生态商店装应用",
    text: "打开“生态商店”安装应用，在“我的应用”启动。应用更新与客户端原生版本更新按界面提示分别进行。",
  },
];
const macSteps = [
  {
    title: "确认芯片，下载 DMG",
    text: "左上角  →“关于本机”，确认是 Apple M 系列芯片。选择 Mac Apple 芯片版下载，Intel Mac 暂不支持。",
  },
  {
    title: "拖入“应用程序”",
    text: "先退出旧客户端。双击 DMG，把应用图标拖进 Applications（应用程序）；同名时选择替换，不必卸载或删除个人数据目录。",
  },
  {
    title: "从应用程序打开",
    text: "打开 Finder →“应用程序”→“千手生态 v3 预览版”。首次遇到开发者验证提示，按下面的 Mac 指南操作。",
  },
  {
    title: "登录，安装生态应用",
    text: "登录生态账号，进入“生态商店”安装所需应用，然后从“我的应用”启动。后续按客户端提示更新。",
  },
];
const steps = computed(() =>
  platform.value === "mac" ? macSteps : windowsSteps,
);
function select(value: string) {
  copyState.value = "";
  router.replace({
    path: "/downloads",
    query: { platform: value },
    hash: "#usage",
  });
}
async function copyCommand(id: string) {
  const value = document.getElementById(id)?.textContent;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copyState.value = "已复制。执行前请核对适用条件和文件路径。";
  } catch {
    copyState.value = "复制失败，请手动选择对应命令复制。";
  }
}
</script>
<style scoped>
.os-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 24px 0;
}
.os-tabs button {
  background: #eef4fb;
  border: 1px solid #b7cde5;
  border-radius: 8px;
  padding: 10px 18px;
  font-size: 15px;
  color: #325675;
}
.os-tabs button[aria-pressed="true"] {
  background: #2563ba;
  border-color: #2563ba;
  color: #fff;
}
.install-steps {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 22px;
  padding: 0 !important;
  margin: 0 0 35px;
}
.install-steps li {
  border-top: 1px solid #bfd0e2;
  padding-top: 18px;
}
.step-index {
  color: #2863a7;
  font:
    14px ui-monospace,
    monospace;
}
.install-steps h3 {
  font-size: 17px;
  margin: 12px 0;
}
.install-steps p {
  font-size: 15px;
  line-height: 1.85;
}
.macfix {
  padding-top: 22px;
  border-top: 1px solid #d1deeb;
  scroll-margin-top: 105px;
}
.macfix[hidden] {
  display: none;
}
.sh h2 {
  font-size: 22px;
}
.sh .n {
  display: none;
}
.guide-card {
  padding: 23px;
  background: #f3f7fc;
  border: 1px solid #d1e0f0;
  border-radius: 12px;
  margin: 20px 0;
}
.guide-card p,
.guide-card li {
  font-size: 16px;
  line-height: 1.85;
}
.guide-card h3 {
  font-size: 18px;
}
.guide-card details {
  margin-top: 16px;
}
.cmdrow {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  background: #182e49;
  color: #e2edfb;
  padding: 18px;
  border-radius: 9px;
  margin: 15px 0;
}
.cmdrow code {
  flex: 1;
  min-width: 170px;
  font-size: 14px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.cmdrow button {
  color: #deecff;
  border: 1px solid #6c8aac;
  background: #2c496d;
  border-radius: 6px;
  padding: 7px 12px;
  font-size: 14px;
  text-decoration: none;
}
.pr {
  display: none;
}
.checksum-row {
  border-top: 1px solid #cad9e9;
  margin-top: 18px;
  padding-top: 18px;
  font-size: 14px;
}
.checksum-row code {
  display: block;
  word-break: break-all;
}
.checksum-row p {
  overflow-wrap: anywhere;
}
.copy-feedback {
  position: sticky;
  bottom: 14px;
  background: #e4eefb;
  border: 1px solid #aabfdd;
  border-radius: 8px;
  padding: 12px;
  font-size: 14px;
}
.copy-feedback:empty {
  display: none;
}
@media (max-width: 900px) {
  .install-steps {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 550px) {
  .install-steps {
    grid-template-columns: 1fr;
  }
  .guide-card {
    padding: 18px;
  }
  .cmdrow {
    padding: 14px;
  }
  .cmdrow code {
    min-width: 100%;
    font-size: 13px;
  }
}
</style>
