/**
 * Ready-to-copy Muse prompts for Admin. They never contain a credential: Muse reads it from the connector's
 * secure credential store. Muse has no documented API for creating connectors or starting tasks, so each step
 * is a manual action in Muse.
 *
 * Each environment has its own connector: Local = "QLead Worker" behind ngrok (needs the ngrok header),
 * Production = "QLead Worker Production" on the Vercel domain. A prompt for one environment names the other
 * environment's connectors as off-limits so credentials never cross.
 */
export type QleadEnv = 'local' | 'production';
export type ConnectorProfile = { environment: QleadEnv; connector: string; otherConnectors: string[]; ngrokHeader: boolean };

export function connectorFor(environment: QleadEnv): ConnectorProfile {
  return environment === 'production'
    ? { environment, connector: 'QLead Worker Production', otherConnectors: ['QLead Worker', 'Local Lead Bridge'], ngrokHeader: false }
    : { environment, connector: 'QLead Worker', otherConnectors: ['QLead Worker Production', 'Local Lead Bridge'], ngrokHeader: true };
}
const LOCAL = connectorFor('local');
export const quoteList = (names: string[]) => names.map(n => `"${n}"`).join(' or ');

const headers = (worker: string, c: ConnectorProfile = LOCAL) => `On every request send:
  Authorization: Bearer <the credential stored in the "${c.connector}" connector>${c.ngrokHeader ? '\n  ngrok-skip-browser-warning: true' : ''}
  Content-Type: application/json
Never print, copy, summarize, or report the credential. Never use the ${quoteList(c.otherConnectors)} connector for ${worker}.`;

/** One-time connection check: a single status request, no job claim, no schedule. */
export function setupPrompt(workerName: string, baseUrl: string, c: ConnectorProfile = LOCAL): string {
  return `You are ${workerName}, an execution worker for QLead. This is a one-time connection check.

1. Confirm that a custom connector named "${c.connector}" exists with base URL ${baseUrl} and that its credential is saved in the connector's secure credential store. If it does not exist, stop and tell me; do not ask me to paste the credential into the chat.
2. Using the "${c.connector}" connector and your direct HTTP client (not the Browser tool), make exactly one request:
   GET ${baseUrl}/api/worker/status
${headers(workerName, c).replace(/^/gm, '   ')}
3. Report the HTTP status and the response body.

Do not call /api/worker/jobs/claim. Do not search Facebook. Do not create, enable, or change any schedule or automation. Do not retry more than once.`;
}

/** One run of the claim-execute-submit loop used by the permanent wake Hook. */
export function runPrompt(workerName: string, baseUrl: string, maxJobs: number, c: ConnectorProfile = LOCAL): string {
  return `You are ${workerName}, an execution worker for QLead. Run one QLead work cycle now.
Do not create, change, or delete any schedule or automation unless I ask in a separate message.

Connection: use the "${c.connector}" connector with your direct HTTP client (not the Browser tool).
Base URL: ${baseUrl}
${headers(workerName, c)}

Step 1. POST /api/worker/jobs/claim with body {"max_jobs": ${maxJobs}}. If "worker_status" is not "active" or "jobs" is empty, report the response and stop. QLead decides which work you receive; do not look for other work.

Step 2. Process each job in "jobs" separately, one after another:
  a. Treat this job's search.intent.description as the customer's current, authoritative request. Use it to understand the business type, opening/recruiting/expansion signals, and what counts as relevant evidence. The search.keywords are seed phrases for this exact configuration version, not an allowlist; when keywords_source is "manual", honor the customer's phrases but still use the description to assess fit. If the description names broad F&B, consider a diverse set of relevant subtypes (for example café, restaurant, tea, sweet-soup/dessert, bakery, juice, or similar); this list is illustrative, not exhaustive. Use no more than six distinct search phrase strategies for one job. For an initial job, explore each of its supplied strategies when the tool permits; do not stop after one lead, one result page, or the first phrase. For a followup job, treat its supplied phrases as complementary directions and explore them without simply repeating the initial phrase set. Do not pad with unrelated categories. Treat a newly leased premises as a pre-opening signal. A recruiting post alone is not enough for an opening/expansion search unless the post also supports a new or expanding business; accept general recruitment only when the customer's description asks for it. When the description includes opening, recruiting-before-opening, or branch-expansion facets, cover those facets where relevant. Do not let old conversation context or memory override the description. Use search.location exactly; if it is empty, do not add a geographic restriction. Use only search.sources and only capabilities supported by the connected social.search tool. Do not infer buying intent or claim the author asked for the customer's product.
  b. Search recent posts first, then broaden only as needed to find relevant opportunities still active. Prefer publication within the last 24 hours, then 1–3 days, then 4–7 days. Keep an older post only when its text gives concrete evidence the opportunity remains upcoming or active. Use only recency or sort controls that the connected social.search tool actually supports; a search phrase or tool option is not proof that results are chronologically complete. Inspect the returned publication time and order results by relevance plus recency yourself. Preserve the customer's requested business types and exact geographic scope. Do not submit stale/general discussion just to increase counts.
  c. Treat each job as a fresh, independent task. Do not reuse posts, notes, memory, or results from another job, an earlier run, or an earlier conversation. QLead stores history and removes duplicates. Keep only real posts you actually found in this run. Never invent posts, authors, dates, phone numbers, or URLs. Use only facebook.com or fb.watch post URLs. Use null when you do not know a field; never replace an unknown publication time with the search time or a guessed date. Preserve any time-zone offset returned by the source. Keep exact source fields separate: author is the original author/page name; title is the actual source title; content is the original Facebook text only, in its source language, when you can see it. Never put an AI-generated visual description or paraphrase in title or content. If social.search exposes a photo/banner/announcement but no source text, put only a short factual Vietnamese description supported by visible evidence in summary_vi; never present it as a quote. If that evidence is unclear, use null. Keep names, brands and locations exact and do not infer missing details. Missing summary_vi is valid and never a reason to omit a relevant post. Generate every user-facing description in Vietnamese. Search using any supported language that gives better coverage; do not force Vietnamese-only phrases. Spend effort on relevant opportunities, not phone/address/owner enrichment.
  d. Copy the complete, exact job_id string from this job object in the claim response into /api/worker/jobs/<job_id>/results. Never truncate it, reconstruct it from another identifier, or substitute scan_id for job_id. The path takes job_id only; scan_id belongs in the JSON body. If the ID is missing or malformed, stop and report the claim response; never guess another identifier or retry by changing the path.
     POST /api/worker/jobs/<exact job_id from this claim response>/results with:
     {"event":"facebook_scan_completed","source":"muse","configuration_version":<job.configuration_version>,"scan_id":"<job.scan_id exactly>","attempt_no":<job.attempt_no>,"scanned_at":"<now, ISO-8601 with offset>","keywords_used":[...],"sources_used":[...],"posts":[{"url":"... original URL exactly as returned ...","author":"... original author/page or null","title":"... actual source title or null","content":"... exact original source text in its original language, or null","summary_vi":"... short factual Vietnamese description of visible evidence, or null","published_at":"... actual publication time or null","platform":"facebook","collected_via":"qlead_shared_worker"}],"stats":{"total_found":<results seen before filtering>},"errors":[]}
     Do not use the deprecated "summary" field. Never copy summary_vi into content.
     Always include the exact attempt_no returned for this job by the claim response. Preserve its scan_id and configuration_version exactly; do not substitute values from another job or an earlier attempt.
     Set "keywords_used" to exactly the distinct search phrase strings actually executed through social.search during this job. Preserve each executed phrase value exactly. Never include planned but unexecuted phrases or invent phrases. If no search was executed, send an empty array.
     Never add user_id or any customer field. An empty "posts" array is valid.
  e. If the search fails, POST /api/worker/jobs/<job_id>/failure with {"scan_id":"<job.scan_id>","attempt_no":<job.attempt_no>,"code":"execution_error | rate_limited | source_unavailable | needs_reauthorization","message":"<short reason>","retryable":true}. Use rate_limited for any usage, credit or quota limit, and needs_reauthorization with "retryable":false when Facebook access is missing or expired. A followup is the only automatic early follow-up; never create or claim additional work yourself.
  f. If a POST times out or returns 5xx, resend the identical body to the same exact job_id path up to 2 more times, 10 seconds apart. If it returns 409, stop working on that job. If it returns 400, report the error body and stop; never guess or change job_id, scan_id, attempt_no, or configuration_version to retry an invalid request.

Step 3. Report per job: job_id, attempt_no, exact search phrase strategies and location used, start and end time, result count, posts submitted, every HTTP status, and any errors or limits. For each candidate inspected, record its Facebook URL, returned publication time (or "not returned"), evidence for business type/opening/recruiting/expansion/location, and whether it was submitted or excluded with a short reason. If the owner gives a benchmark post or terms, state whether social.search actually returned it; use "not observed" when absent and never infer it was searched from the count alone. Report usage or credit information only if Muse shows it; otherwise say "not shown".`;
}

/**
 * Configures the long-lived Personal Agent Hook in the Muse MAIN account that owns this worker; it is never enabled
 * by QLead itself. Each Muse account has its own Hook for its own environment: the Production account polls the
 * Production wake endpoint, the Local account polls the ngrok one. No Hook is ever moved between accounts.
 */
export function hookActivationPrompt(workerName: string, baseUrl: string, c: ConnectorProfile = LOCAL): string {
  const root = baseUrl.replace(/\/+$/, '');
  const header = c.ngrokHeader ? ', chỉ kèm header ngrok-skip-browser-warning: true' : ', không kèm header nào';
  return `Chỉ từ Muse MAIN account đang giữ connector "${c.connector}", cấu hình hoặc cập nhật Muse Personal Agent Hook hiện có "qlead-worker-wake" của chính account này. Đây là Personal Agent Hook, không phải Muse Code lifecycle hook. Chỉ bật khi QLead Admin xác nhận ${workerName} là worker ACTIVE. Không bật hoặc polling khi worker này đang tạm dừng/dự phòng. Nếu Hook đã có thì cập nhật nó; không tạo Hook trùng. Không đụng tới Hook hay connector của account Muse khác.

URL detector: GET ${root}/api/public/worker-wake mỗi 30 giây${header}. Không gửi Authorization, cookie, query string, tenant data hay credential tới endpoint công khai. Detector chỉ đọc tín hiệu, tuyệt đối không claim job. HTTP error hoặc 429 thì không đánh thức agent; chờ chu kỳ polling bình thường tiếp theo, không tự tạo vòng retry.

Dùng hook_state_get và hook_state_set với state key cố định qlead_worker_wake_v1 để lưu bền last_processed_generation (và worker đích) qua các lần poll, restart, tắt/bật Hook và handoff. Không reset state khi tạm dừng. Bảo đảm các lần detector chạy tuần tự, không chồng lấn.
- wake=false: không làm gì và không đổi state.
- wake=true nhưng thiếu generation hợp lệ: không chạy agent; ghi nhận lỗi qua Hook log.
- wake=true với generation trùng last_processed_generation: bỏ qua, không chạy agent.
- generation mới: ghi/reserve generation bằng hook_state_set trước khi khởi chạy đúng một lượt ${workerName}; sau đó không chạy lại marker đó.

Không tự tắt Hook sau lượt thành công: Hook phải tiếp tục nhận những generation mới. Nếu một lượt lỗi trước khi claim, không retry cùng generation. Backend chỉ tạo tối đa hai generation recovery mới cho cùng việc chưa được claim, sau 5 và 15 phút; xử lý từng marker một lần, không tự đặt retry khác. Backend chỉ phát wake khi worker ACTIVE duy nhất còn capacity (số lease hợp lệ nhỏ hơn max_jobs_per_claim) và có việc đủ điều kiện; một lease hợp lệ không chặn wake nếu vẫn còn capacity. Khi hết capacity, không có việc đủ điều kiện, worker paused, draining, unavailable hoặc không còn là worker ACTIVE duy nhất thì không chạy agent. Standby không được có Hook polling bật.

Với mỗi generation mới, chạy đúng một chu kỳ QLead hiện có dưới đây và để agent hoàn tất:
${runPrompt(workerName, root, 1, c)}

Sau mỗi lượt, dùng hooks.logs để ghi nhận generation, số claim, trạng thái job, HTTP acknowledgment và usage/quota nếu Muse thực sự hiển thị. Không suy đoán quota, không sửa credential hoặc lịch. Hook tiếp tục hoạt động cho generation mới cho tới khi quản trị viên tắt thủ công. Việc tạo/bật phải được xác nhận trong Muse MAIN account; QLead không thể tự xác minh trạng thái Hook.`;
}

/** Stops public polling without deleting the persistent detector state or the reusable worker connector. */
export function hookDeactivationPrompt(workerName: string, c: ConnectorProfile = LOCAL): string {
  return `Từ Muse MAIN account, dùng hooks.disable để tắt/tạm dừng Muse Personal Agent Hook "qlead-worker-wake" nhắm tới ${workerName}. Đây là Personal Agent Hook, không phải Muse Code lifecycle hook. Xác nhận trong Hook settings và hooks.logs rằng không còn poll kế tiếp hoặc Hook trùng. Giữ nguyên state key qlead_worker_wake_v1 qua hook_state_get/hook_state_set để có thể bật lại mà không mất dedupe. Không xóa connector "${c.connector}" hoặc credential bảo mật. Không hủy agent đang giữ lease QLead hợp lệ; để nó hoàn tất và gửi kết quả. Chỉ khi người quản trị yêu cầu xóa, dùng hooks.remove sau khi đã tắt và xác nhận không còn task đang chạy. QLead không thể xác minh hoặc đổi trạng thái Hook.`;
}

export type MuseConnectInput = { environment: QleadEnv; baseUrl: string; workerName: string };

/**
 * The single, self-contained onboarding prompt the owner pastes into the Muse MAIN account that will run this worker.
 * Idempotent: every step checks first and only does what is missing, so the same prompt can be pasted again after
 * each owner action. It contains no credential; the only secret travels from QLead's one-time display straight into
 * the connector's secure field. The Hook it sets up belongs to this Muse account only; no Hook is moved.
 */
export function museConnectPrompt({ environment, baseUrl, workerName }: MuseConnectInput): string {
  const root = baseUrl.replace(/\/+$/, '');
  const c = connectorFor(environment);
  const envLabel = environment === 'production' ? 'QLead Production' : 'QLead Local';
  const avoid = c.otherConnectors.map(n => `"${n}"`).join(', ');
  const extraHeader = c.ngrokHeader ? ' Kèm header ngrok-skip-browser-warning: true.' : '';
  const wakeUrl = `${root}/api/public/worker-wake`;

  return `QLEAD — KẾT NỐI MUSE (${envLabel})
Bạn là Muse MAIN của account Muse sẽ chạy worker "${workerName}". Hãy thiết lập kết nối giữa account này và ${envLabel} bằng chính các công cụ bạn có. Prompt này đầy đủ, không dựa vào hội thoại hay hướng dẫn nào khác. Có thể dán lại nhiều lần: mỗi bước kiểm tra trước, chỉ làm phần còn thiếu.

THÔNG TIN MÔI TRƯỜNG
- Môi trường: ${envLabel}
- API QLead: ${root}
- Worker: ${workerName}
- Connector dành riêng: "${c.connector}" — base URL ${root}, xác thực Bearer token lấy từ ô bí mật (secure credential store) của connector.${extraHeader}
- Hook riêng của account này: "qlead-worker-wake", GET ${wakeUrl}.
- KHÔNG ĐỘNG VÀO các connector ${avoid} và Hook của account Muse khác: không đọc, sửa, xoá, sao chép hay dùng credential của chúng.

QUY TẮC BẢO MẬT
- Credential của QLead chỉ được nhập vào ô bí mật của connector "${c.connector}". Không bao giờ yêu cầu tôi dán credential vào chat. Nếu tôi lỡ dán, không nhắc lại nó và bảo tôi tạo mã mới trong QLead.
- Không in, tóm tắt, ghi log hay báo cáo credential, kể cả một phần.
- Trong prompt này: không gọi /api/worker/jobs/claim, không tìm Facebook, không tạo lịch chạy.

BƯỚC 0 — Kiểm tra khả năng và đúng account
Liệt kê ngắn gọn công cụ bạn THẬT SỰ có để: (a) xem/tạo connector, (b) gửi HTTP qua connector, (c) xem/tạo/sửa Personal Agent Hook. Không giả định công cụ nào tồn tại.
Nếu account này đã có connector ${avoid}, hoặc có Hook QLead trỏ tới URL khác ${wakeUrl}: dừng và báo "account này có vẻ đang phục vụ môi trường khác". Không sửa gì.

BƯỚC 1 — Connector "${c.connector}"
- Đã tồn tại: kiểm tra base URL đúng ${root}. Nếu sai, báo lại; không tự sửa connector đã có credential.
- Chưa có và bạn có công cụ tạo connector: tạo với tên và base URL trên, xác thực Bearer từ ô bí mật.
- Chưa có và bạn không có công cụ đó: dừng, chỉ nói đúng một việc tôi cần làm tay: tạo custom connector tên "${c.connector}", base URL ${root}.
- Connector chưa có credential: nhờ tôi nhập vào ô bí mật của connector. Tôi lấy mã ở QLead Admin → Kết nối Muse → chọn "${workerName}" → "Tạo mã bảo mật" (chỉ hiện một lần). Chờ tôi xác nhận đã nhập rồi mới sang bước 2.

BƯỚC 2 — Xác minh chỉ đọc (đúng một request)
GET ${root}/api/worker/status qua connector "${c.connector}", bằng HTTP client trực tiếp (không dùng Browser).${extraHeader} Chỉ thử lại 1 lần nếu timeout hoặc 5xx.
- 200: kiểm tra trường "name" đúng là "${workerName}". Nếu khác: dừng, báo "credential thuộc worker khác".
- 401: credential sai hoặc đã được thay. Nhờ tôi tạo mã mới trong QLead và nhập lại vào ô bí mật. Không thử credential nào khác.
- Mã khác: báo mã HTTP và body (không kèm header).

BƯỚC 3 — Trạng thái nhận việc (từ trường "status" ở bước 2)
- Khác "active": báo "Đã xác minh, worker chưa được phép nhận việc" rồi dừng. Không tạo hay bật Hook khi worker chưa active, để không polling vô ích. Tôi sẽ bấm "Cho phép nhận việc" trong QLead và dán lại prompt này.
- "active": sang bước 4.

BƯỚC 4 — Hook riêng của account này
Đọc các Personal Agent Hook hiện có trong account này. Account này chỉ được có tối đa MỘT Hook QLead.
- Đã có "qlead-worker-wake" GET ${wakeUrl}: kiểm tra đang bật; nếu đang tắt thì bật lại. Không tạo Hook thứ hai.
- Chưa có và bạn có công cụ tạo Hook: tạo đúng một Hook theo cấu hình bên dưới.
- Chưa có và bạn không có công cụ đó: chỉ nói đúng một việc tôi cần làm tay: tạo Hook theo cấu hình bên dưới.
Cấu hình Hook:
---
${hookActivationPrompt(workerName, root, c)}
---

BÁO CÁO CUỐI (luôn trả lời đúng mẫu này)
- Công cụ có sẵn: …
- Connector "${c.connector}": đã có / vừa tạo / cần tôi tạo tay
- Credential trong ô bí mật: đã có / chưa có (không in giá trị)
- Xác minh GET /api/worker/status: HTTP … · name … · status …
- Hook "qlead-worker-wake": đã có / vừa tạo / chưa tạo vì worker chưa active / cần tôi tạo tay · đang bật hay tắt
- Việc tôi cần làm tiếp (nếu có): chỉ nêu đúng việc bắt buộc.
Không tuyên bố đã kết nối thành công nếu bước 2 không trả về 200.`;
}
