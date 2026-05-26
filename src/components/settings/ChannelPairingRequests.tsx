import { useTranslation } from 'react-i18next';
import { Check, CheckCircle, AlertTriangle, UserCheck } from 'lucide-react';
import type * as events from '../../lib/backend/events';

interface ChannelPairingRequestsProps {
  pendingPairings: events.ImPairingRequestedPayload[];
  onApprove: (code: string) => void | Promise<void>;
  onClear: () => void | Promise<void>;
  pairingCodeInput: string;
  onInputChange: (value: string) => void;
  pairingMessage: string | null;
  pairingMessageType: 'success' | 'error' | null;
}

export function ChannelPairingRequests({
  pendingPairings,
  onApprove,
  onClear,
  pairingCodeInput,
  onInputChange,
  pairingMessage,
  pairingMessageType,
}: ChannelPairingRequestsProps) {
  const { t } = useTranslation('settings');

  if (pendingPairings.length === 0) {
    return null;
  }

  return (
    <div className="border border-light-gray/60 rounded-container p-4 bg-pure-white space-y-4 mt-4">
      <div className="flex flex-col gap-1">
        <span className="font-display font-medium text-[13px] text-pure-black">
          {t('pairingRequests.title')}
        </span>
      </div>

      {/* 手动输入区 */}
      <div className="flex gap-2 max-w-sm">
        <input
          type="text"
          maxLength={6}
          value={pairingCodeInput}
          onChange={(e) => onInputChange(e.target.value.trim())}
          placeholder={t('pairingRequests.enterCode')}
          className="w-full px-3 py-1.5 border border-light-gray/60 rounded-interactive text-[12px] bg-pure-white text-pure-black focus:outline-none focus:border-pure-black transition-colors font-mono tracking-widest text-center text-lg"
        />
        <button
          onClick={() => onApprove(pairingCodeInput)}
          disabled={pairingCodeInput.length !== 6}
          className="flex items-center justify-center gap-1.5 px-4 py-1.5 rounded-interactive text-[11px] font-medium bg-pure-black text-pure-white border border-pure-black hover:bg-near-black disabled:opacity-50 shrink-0"
        >
          <UserCheck className="w-3.5 h-3.5" />
          <span>{t('pairingRequests.approve')}</span>
        </button>
      </div>

      {/* 消息反馈 */}
      {pairingMessage && (
        <div className="flex gap-3 p-3 rounded-container bg-light-gray/20 border border-light-gray text-near-black text-[11px] leading-relaxed">
          {pairingMessageType === 'success' ? (
            <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          )}
          <div>{pairingMessage}</div>
        </div>
      )}

      {/* 待处理列表 */}
      <div className="space-y-3 border-t border-light-gray/40 pt-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-silver font-medium uppercase tracking-wider">
            {t('pairingRequests.pending')} ({pendingPairings.length})
          </div>
          <button
            onClick={onClear}
            className="text-[10px] text-stone hover:text-pure-black"
          >
            {t('pairingRequests.clear')}
          </button>
        </div>

        <div className="divide-y divide-light-gray/30">
          {pendingPairings.map((req) => (
            <div key={req.code} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-col gap-0.5">
                <span className="font-display font-medium text-[12px] text-pure-black">
                  {req.display_name} ({req.platform_user_id})
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[13px] font-medium text-pure-black tracking-widest bg-snow border border-light-gray/40 px-2 py-0.5 rounded-interactive">
                  {req.code}
                </span>
                <button
                  onClick={() => onApprove(req.code)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-interactive text-[10px] font-medium border border-light-gray text-stone hover:bg-snow hover:text-pure-black bg-pure-white transition-colors"
                >
                  <Check className="w-3 h-3" />
                  <span>{t('pairingRequests.approve')}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
