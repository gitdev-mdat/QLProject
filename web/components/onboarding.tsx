'use client';

import { useEffect, useRef, useState } from 'react';
import { draftPayload, effectiveKeywords, emptyDraft, planFor, withDescription, type Draft } from '@/lib/profile-draft';
import { frequencyLabel, PROFILE_FREQUENCIES } from '@/lib/profile-state';
import { GoatMascot } from './goat-mascot';
import { Brand, Icon } from './visuals';

const STEPS = ['Bạn là ai, tìm khách nào?', 'Kiểm tra cách tìm', 'Bắt đầu'];

/**
 * Who the customer is and whom they look for. The two examples only prefill an editable description; the third
 * asks for the customer's own words. None of them is a category: the description is the search intent.
 */
const EXAMPLES = [
  { id: 'kiotviet', title: 'Tôi là sale bán phần mềm KiotViet', hint: 'Tôi đang tìm các quán F&B sắp khai trương.',
    text: 'Tôi là sale bán phần mềm của KiotViet, tôi đang tìm các quán F&B sắp khai trương.' },
  { id: 'dining-supplies', title: 'Tôi là đại lý bán chén, đũa và dụng cụ ăn uống', hint: 'Tôi đang tìm các quán ăn, nhà hàng F&B sắp khai trương.',
    text: 'Tôi là đại lý bán chén, đũa và các dụng cụ ăn uống cho quán ăn, nhà hàng. Tôi đang tìm các quán ăn, nhà hàng F&B sắp khai trương.' },
] as const;
const CUSTOM = 'custom';

/**
 * `texts` keeps one description per choice, so switching between the examples and "Ngành khác" never overwrites
 * what the customer typed under another choice. Older saved progress (one shared description) is migrated.
 */
type Saved = { step: number; draft: Draft; choice: string | null; texts?: Record<string, string>; suggestedFor?: string };

/**
 * Onboarding for the signed-in customer. Progress is kept per user in this browser so a reload or a step back never
 * loses what was typed; nothing is saved to the account until the last step.
 */
export function Onboarding({ userId, displayName }: { userId: string; displayName: string }) {
  const storageKey = `qlead-onboarding-${userId}`;
  const [state, setState] = useState<Saved>({ step: 0, draft: emptyDraft, choice: null, texts: {} });
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { step, draft, choice } = state;
  const describeBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as Saved;
        const known = saved.choice === CUSTOM || EXAMPLES.some(example => example.id === saved.choice);
        const choice = known ? saved.choice : saved.draft?.description ? CUSTOM : null;
        const texts = saved.texts ?? (choice && saved.draft?.description ? { [choice]: saved.draft.description } : {});
        setState({ ...saved, choice, texts, draft: { ...emptyDraft, ...saved.draft, location: '' } });
      }
    } catch { /* start fresh */ }
    setRestored(true);
  }, [storageKey]);
  useEffect(() => {
    if (!restored) return;
    try { window.localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* storage unavailable */ }
  }, [restored, state, storageKey]);

  const set = (patch: Partial<Saved>) => setState(current => ({ ...current, ...patch }));
  const setDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => setState(current => ({ ...current, draft: { ...current.draft, [key]: value } }));
  const keywords = effectiveKeywords(draft);
  const plan = planFor(draft);
  const canReview = draft.description.trim().length >= 5;
  const canFinish = Boolean(canReview && keywords.length);

  function choose(id: string) {
    setState(current => {
      const known = current.texts ?? {};
      const example = EXAMPLES.find(item => item.id === id);
      const description = known[id] ?? example?.text ?? '';
      return { ...current, choice: id, texts: { ...known, [id]: description }, draft: { ...current.draft, description } };
    });
    // Writing their own words is the point of the custom choice, so the box is ready for typing.
    if (id === CUSTOM) window.requestAnimationFrame(() => describeBox.current?.focus());
  }
  function describe(value: string) {
    setState(current => ({ ...current, texts: { ...(current.texts ?? {}), [current.choice ?? CUSTOM]: value }, draft: { ...current.draft, description: value } }));
  }
  function toReview() {
    // Suggest a name only when the description changed, so stepping back and forth keeps the customer's edits.
    const description = draft.description.trim();
    if (description === state.suggestedFor) { set({ step: 1 }); return; }
    const next = withDescription({ ...draft, name: '', nameEdited: false, keywordsSource: 'description', keywords: '' }, description);
    // No region is applied: Facebook posts rarely carry a reliable place, so a filter would hide real opportunities.
    set({ step: 1, suggestedFor: description, draft: { ...next, location: '' } });
  }

  async function finish() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/onboarding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: draftPayload({ ...draft, location: '' }), enabled: draft.enabled }) });
      const data = await response.json().catch(() => ({})) as { redirect?: string; error?: string };
      if (!response.ok || !data.redirect) throw new Error(data.error === 'invalid_request' ? 'Hãy quay lại và mô tả rõ hơn khách hàng bạn muốn tìm.' : 'Không lưu được. Thử lại sau ít phút.');
      try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
      window.location.assign(data.redirect);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Không lưu được.');
      setBusy(false);
    }
  }

  const custom = choice === CUSTOM;
  return <div className="onboarding">
    <header className="onboarding-head"><Brand/><span>Bước {step + 1}/{STEPS.length}</span></header>
    <div className="onboarding-progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-label="Tiến độ thiết lập"><i style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}/></div>
    <main className="onboarding-body">
      {step === 0 && <section aria-labelledby="ob-title">
        <p className="onboarding-hello">Chào {displayName}!</p>
        <h1 id="ob-title">Bạn là ai và muốn tìm khách hàng nào?</h1>
        <p>Chọn một ví dụ gần với bạn rồi sửa lại, hoặc tự mô tả bằng lời của bạn. QLead tìm trên Facebook theo đúng mô tả này.</p>
        <div className="intent-options" role="group" aria-label="Chọn cách bắt đầu">
          {EXAMPLES.map(example => <button key={example.id} type="button" className="intent-option" aria-pressed={choice === example.id} onClick={() => choose(example.id)}>
            <span className="intent-check" aria-hidden="true"><Icon name="check" size={14}/></span>
            <b>{example.title}</b>
            <span>{example.hint}</span>
          </button>)}
          <button type="button" className="intent-option is-custom" aria-pressed={custom} onClick={() => choose(CUSTOM)}>
            <span className="intent-check" aria-hidden="true"><Icon name="edit" size={15}/></span>
            <b>Ngành khác? Tự mô tả khách hàng</b>
            <span>Bạn kinh doanh ngành nào cũng được. Hãy mô tả khách hàng mà bạn muốn tìm.</span>
          </button>
        </div>
        {choice && <div className="field onboarding-describe">
          <label htmlFor="ob-description">{custom ? 'Mô tả của bạn' : 'Mô tả (bạn có thể sửa lại cho đúng với mình)'}</label>
          <textarea ref={describeBox} id="ob-description" aria-describedby="ob-prompts" className="text-area" rows={4} maxLength={1000} value={draft.description} autoFocus={custom} onChange={event => describe(event.target.value)}
            placeholder="Ví dụ: Tôi bán máy lọc nước cho văn phòng. Tôi đang tìm các công ty, văn phòng mới thành lập hoặc vừa chuyển địa điểm."/>
          <ul id="ob-prompts" className="onboarding-prompts" aria-label="Nên nói rõ">
            <li><b>Bạn là ai?</b></li>
            <li><b>Bạn bán sản phẩm, dịch vụ gì?</b></li>
            <li><b>Bạn muốn tìm khách hàng nào?</b></li>
          </ul>
        </div>}
      </section>}

      {step === 1 && <section aria-labelledby="ob-review">
        <h1 id="ob-review">Kiểm tra trước khi lưu</h1>
        <p>Đây là mô tả QLead sẽ dùng để tìm. Muốn đổi cách tìm, hãy quay lại sửa mô tả.</p>
        <blockquote className="onboarding-quote">“{draft.description}”</blockquote>
        <div className="field-grid profile-fields onboarding-fields">
          <label className="field">Tên nhu cầu<input value={draft.name} maxLength={80} onChange={event => set({ draft: { ...draft, name: event.target.value, nameEdited: true } })} placeholder={plan.name || 'Ví dụ: Quán F&B sắp khai trương'}/></label>
          <label className="field">Tần suất quét<select aria-label="Tần suất quét" value={draft.frequency} onChange={event => setDraft('frequency', Number(event.target.value))}>{PROFILE_FREQUENCIES.map(minutes => <option key={minutes} value={minutes}>{frequencyLabel(minutes).replace(/^m/, 'M')}</option>)}</select></label>
        </div>
        <section className="search-preview" aria-label="QLead hiểu mô tả của bạn">
          <p className="search-preview-title"><Icon name="spark" size={16}/>QLead hiểu mô tả của bạn như sau</p>
          <p className="search-preview-note">Một vài cách tìm ban đầu trên Facebook:</p>
          <ul className="keyword-chips">{keywords.map(keyword => <li key={keyword}>{keyword}</li>)}</ul>
          <p className="search-preview-note">Đây chỉ là điểm bắt đầu. QLead luôn giữ ý chính trong mô tả của bạn và có thể thử thêm các cách tìm liên quan để không bỏ sót cơ hội.</p>
          {/* Place-related hints are left out: onboarding no longer offers a region filter. */}
          {plan.notes.filter(note => !note.startsWith('Mô tả nhắc nhiều nơi')).map(note => <p key={note} className="search-preview-note is-hint"><Icon name="info" size={14}/>{note}</p>)}
        </section>
      </section>}

      {step === 2 && <section className="onboarding-done" aria-labelledby="ob-done">
        <GoatMascot size="md"/>
        <h1 id="ob-done">Sẵn sàng lưu nhu cầu đầu tiên</h1>
        <dl className="onboarding-summary">
          <div><dt>Nhu cầu</dt><dd>{draft.name}</dd></div>
          <div><dt>Mô tả</dt><dd>{draft.description}</dd></div>
          <div><dt>Tần suất</dt><dd>{frequencyLabel(draft.frequency).replace(/^m/, 'M')}</dd></div>
        </dl>
        <label className="check-line"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft('enabled', event.target.checked)}/>Bật theo dõi ngay sau khi lưu</label>
        <p className="muted-text">{draft.enabled ? 'QLead xếp lượt tìm đầu tiên ngay sau khi lưu. Cơ hội mới sẽ hiện ở trang Hôm nay.' : 'Nhu cầu được lưu dạng nháp. Bạn bật theo dõi khi sẵn sàng.'}</p>
        {error && <p className="warning-line" role="alert"><Icon name="info" size={16}/>{error}</p>}
      </section>}

      <div className="onboarding-actions">
        {step > 0 && <button className="btn btn-outline" type="button" onClick={() => set({ step: step - 1 })}><Icon name="back" size={16}/>Quay lại</button>}
        {step === 0 && <button className="btn btn-primary" type="button" disabled={!canReview} onClick={toReview}>Tiếp tục <Icon name="arrow" size={16}/></button>}
        {step === 1 && <button className="btn btn-primary" type="button" disabled={!canFinish} onClick={() => set({ step: 2 })}>Tiếp tục <Icon name="arrow" size={16}/></button>}
        {step === 2 && <button className="btn btn-primary" type="button" disabled={busy || !canFinish} onClick={finish}>{busy ? 'Đang lưu…' : 'Lưu và vào QLead'} {!busy && <Icon name="arrow" size={16}/>}</button>}
      </div>
      {step === 0 && !canReview && <p className="hint">{choice ? 'Viết vài chữ mô tả để tiếp tục.' : 'Chọn một ví dụ hoặc tự mô tả để tiếp tục.'}</p>}
    </main>
  </div>;
}
