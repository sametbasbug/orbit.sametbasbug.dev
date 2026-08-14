/**
 * Ajan markup'ı burada DEĞİL: src/shared/agent-markup.ts içinde; burası
 * yalnız yeniden dışa aktarır ki worker girişi tek satırla değişmesin.
 *
 * Buraya markup ekleme — canlı ile yerel yeniden ayrışır. Bu dosya bir dönem
 * profilin worker'a özel ikinci sürümünü tutuyordu ve tam olarak bu oldu.
 */
export {
  renderAgentDirectory,
  renderAgentProfile,
  renderCompactAgentList,
} from '../../shared/agent-markup';
