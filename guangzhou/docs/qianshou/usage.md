# Using the Qianshou product

English | [中文](usage.zh.md)

This guide walks through what the product window offers, where each feature lives, and how the interface behaves as the window changes size. It describes the surface as it is, not how to install it.

## Opening the product

The product runs in two forms: an installed macOS application, and a development workbench served over a local address. They are separate installations with separate data directories.

A workbench session is authorised by a token in its address. The token changes every time the workbench restarts. A tab opened before a restart shows an authentication notice instead of the interface; reopening the address with the current token restores it. The current token is written to `.artifacts/bridge/workbench.token`.

## The window

The window has three regions. The sidebar on the left carries the brand, the new-conversation button, the conversation list, and the account row at the bottom. The main column carries the current work. The right rail, when open, carries supplementary material for that work.

Sidebar entries are deliberately few: the conversation list, and the account entry. Every other product feature lives in settings, so the first impression is a conversation tool rather than a control panel.

## Starting work

An empty conversation shows a short greeting, four capability cards describing what the assistant can take on, a line of suggested prompts, and the input area.

The input area accepts typed text, pasted content, and dropped or attached files. Above the input sits a row of quick controls for web search, deeper reasoning, files, images, and the full tool menu. To the right of those sit the delivery selector, the model selector, the voice entry, and the send button.

The delivery selector chooses who receives the message: the coordinating assistant, a parallel dispatch, the task currently running, or a queue. Choosing the model sets which model answers; the reasoning effort appears next to the model name.

Selecting a suggestion fills the input rather than sending it, so the text stays editable before it goes out.

While a turn is running, a small indicator pulses beside the status. The pulse is a light change only, so nothing on the screen moves while it breathes.

## Settings

Settings hold every product feature. Opening settings from the bottom of the sidebar reveals sections for the agent plaza, task centre, workflows, marketplace, account and plan, files and data, models and API, collaboration devices, and model routing, alongside the general, model, plugin, and about sections.

### Account and plan

The account and plan section shows the signed-in account, its plan, and the credit remaining in the current window. The same numbers appear wherever the account is shown, because both surfaces read one source.

### Appearance

The appearance row offers a dark palette and a light palette. The dark palette is a near-black neutral base with a gold accent, and the light palette is a white base with a blue accent. In both, colour is spent on actions and state rather than on surfaces. Each preview shows the palette it selects.

### Model routing

The model-routing section is the administrator console. It lists the published model names and their backends, lets an administrator append a binding, reads the site-wide call ledger, and grants or inspects subscriptions.

Access is granted by the deployment, not by the account's own claim: the gateway refuses these routes unless the deployment has declared which roles are administrators. On a single-user local deployment that declaration is made deliberately, and it is removed before any shared deployment.

## When the window changes size

The interface keeps its region order at every width. Narrowing the window collapses the right rail first, then the sidebar into a narrow track. The input row keeps its own height and drops its least-used quick controls step by step — first the tool menu entry and images, then deeper reasoning, then the whole chip row leaving only the compose button, and finally the delivery selector. Widening the window restores them.

Nothing is lost by that hiding: the compose button opens the full tool menu, and the delivery selector's default is the coordinating assistant.

The interface does not open the right rail on its own when the window grows. A rail that the user opened earlier returns when there is room for it again.

## Reading a failure

A turn that fails reports the failure inline with its code. The authentication failure code covers any rejected credential or identity check, so it means the model endpoint refused the request; the account and plan section shows whether the session and credit are otherwise healthy.
