import { Component, type ErrorInfo, type ReactNode } from 'react';
import { WebRTCManager } from './lib/webrtc';

/**
 * Arayüz çökerse oturumu güvenli biçimde kapatır (denetim 2026-10-07, Y3).
 *
 * React bir render hatasında tüm kökü söker. Eskiden RTCPeerConnection,
 * ekran paylaşımı ve ana süreçteki uzaktan kontrol izni ayakta kalıyordu:
 * kullanıcı ekranda "Kes" düğmesi olmadan izlenmeye ve kontrol edilmeye
 * devam ediyordu. Burada önce bağlantılar ve izin kapatılır, sonra
 * kullanıcıya yeniden yükleme seçeneği gösterilir.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try { WebRTCManager.closeAll(); } catch { /* devam */ }
    try {
      const api = (window as unknown as { electronAPI?: { revokeRemoteControl?: () => void } }).electronAPI;
      api?.revokeRemoteControl?.();
    } catch { /* devam */ }
    console.error('Arku arayüz hatası; oturumlar kapatıldı.', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', color: '#eee', background: '#111', minHeight: '100vh' }}>
        <h1 style={{ fontSize: 20, marginBottom: 12 }}>Beklenmeyen bir hata oluştu</h1>
        <p style={{ marginBottom: 20 }}>
          Güvenlik için açık oturumlar kapatıldı ve uzaktan kontrol izni geri alındı.
        </p>
        <button onClick={() => window.location.reload()} style={{ padding: '8px 16px' }}>
          Uygulamayı yeniden yükle
        </button>
      </div>
    );
  }
}
