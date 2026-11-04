'use client';

import { useEffect, useState } from 'react';
import { demoPersonas } from '@/lib/demo-data';
import { draftPayload, effectiveKeywords, emptyDraft, LOCATIONS, planFor, withDescription, type Draft } from '@/lib/profile-draft';
import { frequencyLabel, locationLabel, NO_LOCATION_OPTION, PROFILE_FREQUENCIES } from '@/lib/profile-state';
import { GoatMascot } from './goat-mascot';
import { Brand, Icon } from './visuals';

const STEPS = ['Bạn muốn tìm ai?', 'Kiểm tra điều kiện', 'Bắt đầu'];

type Saved = { step: number; draft: Draft; choice: string | null; suggestedFor?: string };

/**
 * Onboarding for the signed-in customer. Industry cards only prefill the description; "Ngành khác" opens the same
 * description box, so every industry follows one flow. Progress is kept per user in this browser so a reload or a
 * step back never loses what was typed; nothing is saved to the account until the last step.
 */
export function Onboarding({ userId, displayName }: { userId: string; displayName: string }) {
  const storageKey = `qlead-onboarding-${userId}`;
  const [state, setState] = useState<Saved>({ step: 0, draft: emptyDraft, choice: null });
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { step, draft, choice } = state;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) { const saved = JSON.parse(raw) as Saved; setState({ ...saved, draft: { ...emptyDraft, ...saved.draft } }); }
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
  const locations = draft.location && !LOCATIONS.includes(draft.location) ? [draft.location, ...LOCATIONS] : LOCATIONS;
  const canReview = draft.description.trim().length >= 5;
  const canFinish = Boolean(canReview && keywords.length);

  function choose(id: string, request: string) {
    set({ choice: id, draft: { ...draft, description: id === 'custom' ? draft.description : request } });
  }
  function toReview() {
    // Suggest conditions only when the description changed, so stepping back and forth keeps the customer's edits.
    const description = draft.description.trim();
    if (description === state.suggestedFor) { set({ step: 1 }); return; }
    const next = withDescription({ ...draft, name: '', nameEdited: false, keywordsSource: 'description', keywords: '' }, description);
    set({ step: 1, suggestedFor: description, draft: { ...next, location: planFor(next).location ?? '' } });
  }

  async function finish() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/onboarding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: draftPayload(draft), enabled: draft.enabled }) });
      const data = await response.json().catch(() => ({})) as { redirect?: string; error?: string };
      if (!response.ok || !data.redirect) throw new Error(data.error === 'invalid_request' ? 'Hãy quay lại và mô tả rõ hơn khách hàng bạn muốn tìm.' : 'Không lưu được. Thử lại sau ít phút.');
      try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
      window.location.assign(data.redirect);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Không lưu được.');
      setBusy(false);
    }
  }

  return <div className="onboarding">
    <header className="onboarding-head"><Brand/><span>Bước {step + 1}/{STEPS.length}</span></header>
    <div className="onboarding-progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-label="Tiến độ thiết lập"><i style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}/></div>
    <main className="onboarding-body">
      {step === 0 && <section aria-labelledby="ob-title">
        <p className="onboarding-hello">Chào {displayName}!</p>
        <h1 id="ob-title">Bạn đang bán sản phẩm, dịch vụ gì?</h1>
        <p>Chọn một gợi ý hoặc tự mô tả. QLead dùng mô tả này để tạo nhu cầu theo dõi đầu tiên của bạn.</p>
        <div className="persona-options is-large">
          {demoPersonas.map(item => <button key={item.id} type="button" className="persona-option" aria-pressed={choice === item.id} onClick={() => choose(item.id, item.request)}><b>{item.label}</b><span>Gợi ý: {item.request}</span></button>)}
          <button type="button" className="persona-option is-custom" aria-pressed={choice === 'custom'} onClick={() => choose('custom', '')}><b>Ngành khác? Tự mô tả khách hàng</b><span>Bán gì cũng được, chỉ cần mô tả khách bạn muốn tìm.</span></button>
        </div>
        {choice && <label className="field onboarding-describe">Mô tả khách hàng bạn muốn tìm
          <textarea className="text-area" rows={3} maxLength={1000} value={draft.description} autoFocus={choice === 'custom'} onChange={event => setDraft('description', event.target.value)}
            placeholder="Ví dụ: Tôi bán phần mềm quản lý, muốn tìm quán cafe và nhà hàng sắp khai trương tại miền Nam."/>
          <small>Nêu loại khách, dấu hiệu (sắp khai trương, tuyển người, mở chi nhánh…) và khu vực.</small>
        </label>}
      </section>}

      {step === 1 && <section aria-labelledby="ob-review">
        <h1 id="ob-review">Kiểm tra trước khi lưu</h1>
        <p>QLead chuyển mô tả của bạn thành cách tìm trên Facebook. Muốn đổi cách tìm, hãy quay lại sửa mô tả.</p>
        <blockquote className="onboarding-quote">“{draft.description}”</blockquote>
        <div className="field-grid profile-fields">
          <label className="field">Tên nhu cầu<input value={draft.name} maxLength={80} onChange={event => set({ draft: { ...draft, name: event.target.value, nameEdited: true } })} placeholder={plan.name || 'Ví dụ: Quán F&B sắp khai trương'}/></label>
          <label className="field"><span>Khu vực <span className="field-optional">(không bắt buộc)</span></span><select aria-label="Khu vực" value={draft.location} onChange={event => setDraft('location', event.target.value)}><option value="">{NO_LOCATION_OPTION}</option>{locations.map(location => <option key={location} value={location}>{location}</option>)}</select></label>
          <label className="field">Tần suất quét<select aria-label="Tần suất quét" value={draft.frequency} onChange={event => setDraft('frequency', Number(event.target.value))}>{PROFILE_FREQUENCIES.map(minutes => <option key={minutes} value={minutes}>{frequencyLabel(minutes).replace(/^m/, 'M')}</option>)}</select></label>
        </div>
        <section className="search-preview" aria-label="QLead sẽ tìm theo">
          <p className="search-preview-title"><Icon name="spark" size={16}/>QLead sẽ tìm các bài đăng như:</p>
          <ul className="keyword-chips">{keywords.map(keyword => <li key={keyword}>{keyword}</li>)}</ul>
          {plan.notes.map(note => <p key={note} className="search-preview-note is-hint"><Icon name="info" size={14}/>{note}</p>)}
        </section>
      </section>}

      {step === 2 && <section className="onboarding-done" aria-labelledby="ob-done">
        <GoatMascot size="md"/>
        <h1 id="ob-done">Sẵn sàng lưu nhu cầu đầu tiên</h1>
        <dl className="onboarding-summary">
          <div><dt>Nhu cầu</dt><dd>{draft.name}</dd></div>
          <div><dt>Tìm theo</dt><dd>{keywords.join(', ')}</dd></div>
          <div><dt>Khu vực</dt><dd>{locationLabel(draft.location)} · {frequencyLabel(draft.frequency)}</dd></div>
        </dl>
        <label className="check-line"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft('enabled', event.target.checked)}/>Bật theo dõi ngay sau khi lưu</label>
        <p className="muted-text">{draft.enabled ? 'Lượt quét đầu tiên chạy theo lịch. Lead mới sẽ hiện ở trang Hôm nay, chưa có lead nào trước đó.' : 'Nhu cầu được lưu dạng nháp. Bạn bật theo dõi khi sẵn sàng.'}</p>
        {error && <p className="warning-line" role="alert"><Icon name="info" size={16}/>{error}</p>}
      </section>}

      <div className="onboarding-actions">
        {step > 0 && <button className="btn btn-outline" type="button" onClick={() => set({ step: step - 1 })}><Icon name="back" size={16}/>Quay lại</button>}
        {step === 0 && <button className="btn btn-primary" type="button" disabled={!canReview} onClick={toReview}>Tiếp tục <Icon name="arrow" size={16}/></button>}
        {step === 1 && <button className="btn btn-primary" type="button" disabled={!canFinish} onClick={() => set({ step: 2 })}>Tiếp tục <Icon name="arrow" size={16}/></button>}
        {step === 2 && <button className="btn btn-primary" type="button" disabled={busy || !canFinish} onClick={finish}>{busy ? 'Đang lưu…' : 'Lưu và vào QLead'} {!busy && <Icon name="arrow" size={16}/>}</button>}
      </div>
      {step === 0 && !canReview && <p className="hint">Chọn một gợi ý hoặc tự mô tả để tiếp tục.</p>}
    </main>
  </div>;
}
