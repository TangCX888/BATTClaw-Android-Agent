# BATTClaw Core Prompt Matrix Explanation

[中文版本](./prompts_explanation_zh-cn.md) | *English document translated by AI*

> **Introduction**: BATTClaw's power stems not only from its code architecture but also from its highly decoupled, responsibility-clear Prompt engineering. We have broken down the complexity of long-chain tasks into 7 specific prompt files. This document will deeply analyze the core design logic of these 7 files.

---

## 1. Intent Cleaning & Task Splitting (Pre-Planning)

### 📄 `beforePlanning.md`
*   **Role**: Intent pre-processing hub.
*   **Core Logic**:
    *   **Anti-Amnesia Mechanism**: For complex long-form user instructions (e.g., "First go to app A and do something, then go to app B and do something, finally send a WeChat message to C"), the large model is prone to "goal amnesia" during direct execution. This prompt forces the model to break it down into highly independent "coarse-grained sub-task flows" before executing any actions.
    *   **Environment Prediction**: Requires the model to anticipate the underlying environment needed to execute the task (such as required App permissions, prerequisite login states, etc.).

### 📄 `plan_setStep.md`
*   **Role**: Dynamic role assignment, task limitation, and context injection.
*   **Core Logic**:
    *   **Dynamic Difficulty Assessment**: Based on the current sub-task description, assigns a difficulty level (levels 1-3) to the upcoming steps, and dynamically awakens subsequent execution roles (Executor / Restorer / Coordinator) accordingly.
    *   **Strict Boundary Injection**: For operations prone to hallucinations (like "finding a specific product in a complex list"), this prompt injects strict restrictive instructions to the executor: "You must confirm that keyword X has appeared on the page and you are staying in category Y before you are allowed to report the task as successful".

---

## 2. Core Execution Dual-Track (Execution & Auditing)

### 📄 `planner.md`
*   **Role**: Atomic operation planner.
*   **Core Logic**:
    *   **Self-contained Sub-tasks**: Forces every atomic step output by the Planner to be "context-independent". That is, each step must contain a clear [Environmental Anchor] (Where am I?) and [Expected Final State] (What do I want to achieve?), eliminating extremely vague instructions like "click next step".

### 📄 `run_main.md`
*   **Role**: Speculative Executor.
*   **Core Logic**:
    *   **Visual Semantic Mapping**: Maps the complex physical resolutions of Android devices to a unified `1000x1000` logical coordinate system, reducing the model's cognitive load.
    *   **Red-Dot Feedback Correction**: Pioneers a visual correction mechanism. By rendering a "red dot of the previous click" on the screenshot, it requires the model to compare the offset between the actual physical landing point and the intended target, and perform coordinate mental calculation correction in the next round.
    *   **XML Assisted Assertion**: When pure vision cannot determine UI elements, it grants the model the authority to trigger underlying XML tree analysis.

### 📄 `inspector.md`
*   **Role**: Skeptical Auditor.
*   **Core Logic**:
    *   **Anti-Hallucination Dual Review**: After the Executor claims the task is complete, the Inspector must compare the "pre-action screenshot" with the "post-action screenshot".
    *   **False Reporting Interception**: Strictly prevents the large model from fabricating data just to "rush the job". The pass is only allowed when the visual state has genuinely changed and the data logic forms a closed loop.

---

## 3. Fallback & Underlying Specifications (Fallback & Tools)

### 📄 `restorer.md`
*   **Role**: Fault self-healing workflow.
*   **Core Logic**:
    *   **Anomaly Takeover**: Specifically handles insurmountable blocking scenarios such as "App splash screen ads", "system forced update pop-ups", and "graphic CAPTCHAs".
    *   **Plan Reshaping**: After diagnosing the cause of the blockage, instead of terminating the task directly, it generates a temporary "bypass plan" (e.g., clicking skip ad first), and then returns control to the main task flow.

### 📄 `run_tools.md`
*   **Role**: Executor (Function Call Specification).
*   **Core Logic**:
    *   **Physical Action Convergence**: Provides extremely strict physical limitation instructions for `click` and `swipe` operations. For example: forcefully requiring the model to only output the "geometric center point coordinates" of the target control, strictly prohibiting dangerous clicks on UI edges.

---

> **Summary**: These 7 prompts are the invisible cornerstones that allow BATTClaw to maintain an extremely high task completion rate. Developers can customize their own exclusive Agents that fit their business scenarios by fine-tuning the correction threshold in `run_main.md` or modifying the auditing strictness in `inspector.md`.
