import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  fetchCapabilities,
  updateCapabilityStatus,
  updateCapabilityApproval,
  updateCapabilityRisk,
  assignDEsToCapability,
} from '../services/capabilityService';

export type RiskLevel = 'low' | 'medium' | 'high';
export type CapabilityStatus = 'active' | 'disabled' | 'draft';

export interface BusinessCapability {
  id: string;
  name: string;
  description: string;
  workspace: string;
  icon: string;
  status: CapabilityStatus;
  assignedDEs: string[];
  requiredConnectors: string[];
  requiredKnowledge: string[];
  approvalRequired: boolean;
  riskLevel: RiskLevel;
  inputs: string[];
  outputs: string[];
  runCount: number;
  lastRun?: string;
  avgConfidence?: number;
  avgHandleTime?: string;
}

export function useCapabilities() {
  const { authedUser, currentTenant } = useAuth();
  const tenantId = currentTenant?.id;
  const actorId  = authedUser?.id;

  const [capabilities, setCapabilities] = useState<BusinessCapability[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) { setLoading(false); return; }
    setLoading(true);
    fetchCapabilities(tenantId).then(caps => {
      setCapabilities(caps);
      setLoading(false);
    });
  }, [tenantId]);

  const toggleCapability = useCallback(async (id: string) => {
    if (!tenantId) return;
    const cap = capabilities.find(c => c.id === id);
    if (!cap) return;
    const next: CapabilityStatus = cap.status === 'active' ? 'disabled' : 'active';
    setCapabilities(prev => prev.map(c => c.id === id ? { ...c, status: next } : c));
    const ok = await updateCapabilityStatus(id, tenantId, next, actorId);
    if (!ok) setCapabilities(prev => prev.map(c => c.id === id ? { ...c, status: cap.status } : c));
  }, [capabilities, tenantId, actorId]);

  const setApprovalRequired = useCallback(async (id: string, required: boolean) => {
    if (!tenantId) return;
    setCapabilities(prev => prev.map(c => c.id === id ? { ...c, approvalRequired: required } : c));
    const ok = await updateCapabilityApproval(id, tenantId, required, actorId);
    if (!ok) setCapabilities(prev => prev.map(c => c.id === id ? { ...c, approvalRequired: !required } : c));
  }, [tenantId, actorId]);

  const setRiskLevel = useCallback(async (id: string, level: RiskLevel) => {
    if (!tenantId) return;
    setCapabilities(prev => prev.map(c => c.id === id ? { ...c, riskLevel: level } : c));
    await updateCapabilityRisk(id, tenantId, level, actorId);
  }, [tenantId, actorId]);

  const assignDE = useCallback(async (id: string, deIds: string[]) => {
    if (!tenantId) return;
    setCapabilities(prev => prev.map(c => c.id === id ? { ...c, assignedDEs: deIds } : c));
    await assignDEsToCapability(id, tenantId, deIds, actorId);
  }, [tenantId, actorId]);

  return { capabilities, loading, toggleCapability, setApprovalRequired, setRiskLevel, assignDE };
}
