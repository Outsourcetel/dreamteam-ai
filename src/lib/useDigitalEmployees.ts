import { useState, useEffect, useCallback } from 'react';

export interface StoredDE {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'Customer' | 'Internal';
  department: string;
  status: 'active' | 'idle' | 'disabled';
  capabilities: string[];
  channels: string[];
  knowledgeSources: string[];
  confidenceThreshold: number;
  requiredApproval: boolean;
  createdAt: string;
  tasksThisMonth: number;
  successRate: number;
}

const STORAGE_KEY = 'dt_digital_employees';

function load(): StoredDE[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(employees: StoredDE[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(employees));
  } catch {}
}

export function useDigitalEmployees(defaults: StoredDE[]) {
  const [employees, setEmployees] = useState<StoredDE[]>(() => load() ?? defaults);

  useEffect(() => {
    save(employees);
  }, [employees]);

  const hire = useCallback((de: Omit<StoredDE, 'id' | 'createdAt' | 'tasksThisMonth' | 'successRate'>) => {
    const newDE: StoredDE = {
      ...de,
      id: 'de_' + Date.now(),
      createdAt: new Date().toISOString(),
      tasksThisMonth: 0,
      successRate: 100,
    };
    setEmployees(prev => [...prev, newDE]);
    return newDE;
  }, []);

  const update = useCallback((id: string, changes: Partial<StoredDE>) => {
    setEmployees(prev => prev.map(d => d.id === id ? { ...d, ...changes } : d));
  }, []);

  const dismiss = useCallback((id: string) => {
    setEmployees(prev => prev.filter(d => d.id !== id));
  }, []);

  const toggleStatus = useCallback((id: string) => {
    setEmployees(prev => prev.map(d =>
      d.id === id ? { ...d, status: d.status === 'active' ? 'idle' : 'active' } : d
    ));
  }, []);

  return { employees, hire, update, dismiss, toggleStatus };
}
