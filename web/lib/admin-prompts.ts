/**
 * Ready-to-copy Muse prompts for Admin. They never contain a credential: Muse reads it from the connector's
 * secure credential store. Muse has no documented API for creating connectors or starting tasks, so each step
 * is a manual action in Muse.
 */
const headers = (worker: string) => `On every request send:
  Authorization: Bearer <the credential stored in the "QLead Worker" connector>
  ngrok-skip-browser-warning: true
  Content-Type: application/json
Never print, copy, summarize, or report the credential. Never use the "Local Lead Bridge" connector for ${worker}.`;

/** One-time connection check: a single status request, no job claim, no schedule. */
export function setupPrompt(workerName: string, baseUrl: string): string {
  return `You are ${workerName}, an execution worker for QLead. This is a one-time connection check.

1. Confirm that a custom connector named "QLead Worker" exists with base URL ${baseUrl} and that its credential is saved in the connector's secure credential store. If it does not exist, stop and tell me; do not ask me to paste the credential into the chat.
2. Using the "QLead Worker" connector and your direct HTTP client (not the Browser tool), make exactly one request:
   GET ${baseUrl}/api/worker/status
${headers(workerName).replace(/^/gm, '   ')}
3. Report the HTTP status and the response body.

Do not call /api/worker/jobs/claim. Do not search Facebook. Do not create, enable, or change any schedule or automation. Do not retry more than once.`;
}

/** One run of the claim-execute-submit loop used by the permanent wake Hook. */
export function runPrompt(workerName: string, baseUrl: string, maxJobs: number): string {
  return `You are ${workerName}, an execution worker for QLead. Run one QLead work cycle now.
Do not create, change, or delete any schedule or automation unless I ask in a separate message.

Connection: use the "QLead Worker" connector with your direct HTTP client (not the Browser tool).
Base URL: ${baseUrl}
${headers(workerName)}

Step 1. POST /api/worker/jobs/claim with body {"max_jobs": ${maxJobs}}. If "worker_status" is not "active" or "jobs" is empty, report the response and stop. QLead decides which work you receive; do not look for other work.

Step 2. Process each job in "jobs" separately, one after another:
  a. Treat this job's search.intent.description as the customer's current, authoritative request. Use it to understand the business type, opening/recruiting/expansion signals, and what counts as relevant evidence. The search.keywords are seed phrases for this exact configuration version, not an allowlist; when keywords_source is "manual", honor the customer's phrases but still use the description to assess fit. If the description names broad F&B, consider a diverse set of relevant subtypes (for example café, restaurant, tea, sweet-soup/dessert, bakery, juice, or similar); this list is illustrative, not exhaustive. Use no more than six distinct search phrase strategies for one job. For an initial job, explore each of its supplied strategies when the tool permits; do not stop after one lead, one result page, or the first phrase. For a followup job, treat its supplied phrases as complementary directions and explore them without simply repeating the initial phrase set. Do not pad with unrelated categories. Treat a newly leased premises as a pre-opening signal. A recruiting post alone is not enough for an opening/expansion search unless the post also supports a new or expanding business; accept general recruitment only when the customer's description asks for it. When the description includes opening, recruiting-before-opening, or branch-expansion facets, cover those facets where relevant. Do not let old conversation context or memory override the description. Use search.location exactly; if it is empty, do not add a geographic restriction. Use only search.sources and only capabilities supported by the connected social.search tool. Do not infer buying intent or claim the author asked for the customer's product.
  b. Search recent posts first, then broaden only as needed to find relevant opportunities still active. Prefer publication within the last 24 hours, then 1–3 days, then 4–7 days. Keep an older post only when its text gives concrete evidence the opportunity remains upcoming or active. Use only recency or sort controls that the connected social.search tool actually supports; a search phrase or tool option is not proof that results are chronologically complete. Inspect the returned publication time and order results by relevance plus recency yourself. Preserve the customer's requested business types and exact geographic scope. Do not submit stale/general discussion just to increase counts.
  c. Treat each job as a fresh, independent task. Do not reuse posts, notes, memory, or results from another job, an earlier run, or an earlier conversation. QLead stores history and removes duplicates. Keep only real posts you actually found in this run. Never invent posts, authors, dates, phone numbers, or URLs. Use only facebook.com or fb.watch post URLs. Use null when you do not know a field; never replace an unknown publication time with the search time or a guessed date. Preserve any time-zone offset returned by the source. Include the post text in "content" when you can see it.
  d. Copy the complete, exact job_id string from this job object in the claim response into /api/worker/jobs/<job_id>/results. Never truncate it, reconstruct it from another identifier, or substitute scan_id for job_id. The path takes job_id only; scan_id belongs in the JSON body. If the ID is missing or malformed, stop and report the claim response; never guess another identifier or retry by changing the path.
     POST /api/worker/jobs/<exact job_id from this claim response>/results with:
     {"event":"facebook_scan_completed","source":"muse","configuration_version":<job.configuration_version>,"scan_id":"<job.scan_id exactly>","attempt_no":<job.attempt_no>,"scanned_at":"<now, ISO-8601 with offset>","keywords_used":[...],"sources_used":[...],"posts":[{"url":"...","author":"... or null","title":"... or null","content":"... or null","published_at":"<ISO-8601 or null>","platform":"facebook","collected_via":"qlead_shared_worker"}],"stats":{"total_found":<results seen before filtering>},"errors":[]}
     Always include the exact attempt_no returned for this job by the claim response. Preserve its scan_id and configuration_version exactly; do not substitute values from another job or an earlier attempt.
     Set "keywords_used" to exactly the distinct search phrase strings actually executed through social.search during this job. Preserve each executed phrase value exactly. Never include planned but unexecuted phrases or invent phrases. If no search was executed, send an empty array.
     Never add user_id or any customer field. An empty "posts" array is valid.
  e. If the search fails, POST /api/worker/jobs/<job_id>/failure with {"scan_id":"<job.scan_id>","attempt_no":<job.attempt_no>,"code":"execution_error | rate_limited | source_unavailable | needs_reauthorization","message":"<short reason>","retryable":true}. Use rate_limited for any usage, credit or quota limit, and needs_reauthorization with "retryable":false when Facebook access is missing or expired. A followup is the only automatic early follow-up; never create or claim additional work yourself.
  f. If a POST times out or returns 5xx, resend the identical body to the same exact job_id path up to 2 more times, 10 seconds apart. If it returns 409, stop working on that job. If it returns 400, report the error body and stop; never guess or change job_id, scan_id, attempt_no, or configuration_version to retry an invalid request.

Step 3. Report per job: job_id, attempt_no, exact search phrase strategies and location used, start and end time, result count, posts submitted, every HTTP status, and any errors or limits. For each candidate inspected, record its Facebook URL, returned publication time (or "not returned"), evidence for business type/opening/recruiting/expansion/location, and whether it was submitted or excluded with a short reason. If the owner gives a benchmark post or terms, state whether social.search actually returned it; use "not observed" when absent and never infer it was searched from the count alone. Report usage or credit information only if Muse shows it; otherwise say "not shown".`;
}

/** Configures the long-lived Personal Agent Hook from Muse main account; it is never enabled by QLead itself. */
export function hookActivationPrompt(workerName: string, baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  return `Chỉ từ Muse MAIN account, cấu hình hoặc cập nhật Muse Personal Agent Hook hiện có "qlead-worker-wake". Đây là Personal Agent Hook, không phải Muse Code lifecycle hook. Chỉ bật sau khi người quản trị đã phê duyệt và QLead Admin xác nhận ${workerName} là worker ACTIVE được chỉ định. Không bật hoặc polling từ Muse 02/worker standby. Cập nhật Hook hiện có; không tạo Hook trùng.

URL detector: GET ${root}/api/public/worker-wake mỗi 30 giây, chỉ kèm header ngrok-skip-browser-warning: true. Không gửi Authorization, cookie, query string, tenant data hay credential tới endpoint công khai. Detector chỉ đọc tín hiệu, tuyệt đối không claim job. HTTP error hoặc 429 thì không đánh thức agent; chờ chu kỳ polling bình thường tiếp theo, không tự tạo vòng retry.

Dùng hook_state_get và hook_state_set với state key cố định qlead_worker_wake_v1 để lưu bền last_processed_generation (và worker đích) qua các lần poll, restart, tắt/bật Hook và handoff. Không reset state khi tạm dừng. Bảo đảm các lần detector chạy tuần tự, không chồng lấn.
- wake=false: không làm gì và không đổi state.
- wake=true nhưng thiếu generation hợp lệ: không chạy agent; ghi nhận lỗi qua Hook log.
- wake=true với generation trùng last_processed_generation: bỏ qua, không chạy agent.
- generation mới: ghi/reserve generation bằng hook_state_set trước khi khởi chạy đúng một lượt ${workerName}; sau đó không chạy lại marker đó.

Không tự tắt Hook sau lượt thành công: Hook phải tiếp tục nhận những generation mới. Nếu một lượt lỗi trước khi claim, không retry cùng generation. Backend chỉ tạo tối đa hai generation recovery mới cho cùng việc chưa được claim, sau 5 và 15 phút; xử lý từng marker một lần, không tự đặt retry khác. Backend chỉ phát wake khi worker ACTIVE duy nhất còn capacity (số lease hợp lệ nhỏ hơn max_jobs_per_claim) và có việc đủ điều kiện; một lease hợp lệ không chặn wake nếu vẫn còn capacity. Khi hết capacity, không có việc đủ điều kiện, worker paused, draining, unavailable hoặc không còn là worker ACTIVE duy nhất thì không chạy agent. Standby không được có Hook polling bật.

Với mỗi generation mới, chạy đúng một chu kỳ QLead hiện có dưới đây và để agent hoàn tất:
${runPrompt(workerName, root, 1)}

Sau mỗi lượt, dùng hooks.logs để ghi nhận generation, số claim, trạng thái job, HTTP acknowledgment và usage/quota nếu Muse thực sự hiển thị. Không suy đoán quota, không sửa credential hoặc lịch. Hook tiếp tục hoạt động cho generation mới cho tới khi quản trị viên tắt thủ công. Việc tạo/bật phải được xác nhận trong Muse MAIN account; QLead không thể tự xác minh trạng thái Hook.`;
}

/** Stops public polling without deleting the persistent detector state or the reusable worker connector. */
export function hookDeactivationPrompt(workerName: string): string {
  return `Từ Muse MAIN account, dùng hooks.disable để tắt/tạm dừng Muse Personal Agent Hook "qlead-worker-wake" nhắm tới ${workerName}. Đây là Personal Agent Hook, không phải Muse Code lifecycle hook. Xác nhận trong Hook settings và hooks.logs rằng không còn poll kế tiếp hoặc Hook trùng. Giữ nguyên state key qlead_worker_wake_v1 qua hook_state_get/hook_state_set để có thể bật lại mà không mất dedupe. Không xóa connector "QLead Worker" hoặc credential bảo mật. Không hủy agent đang giữ lease QLead hợp lệ; để nó hoàn tất và gửi kết quả. Chỉ khi người quản trị yêu cầu xóa, dùng hooks.remove sau khi đã tắt và xác nhận không còn task đang chạy. QLead không thể xác minh hoặc đổi trạng thái Hook.`;
}
