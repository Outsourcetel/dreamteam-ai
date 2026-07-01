import { useState, useCallback, useEffect } from 'react';

export interface Department {
  id: string;
  name: string;
  description: string;
  head: string;
  memberCount: number;
  color: string;
  createdAt: string;
}

const DEFAULT_DEPARTMENTS: Department[] = [
  { id: 'd1', name: 'Leadership', description: 'Executive and senior leadership team', head: 'Sarah Mitchell', memberCount: 2, color: '#6366f1', createdAt: '2026-01-15' },
  { id: 'd2', name: 'IT', description: 'Technology infrastructure and support', head: 'James Okafor', memberCount: 3, color: '#3b82f6', createdAt: '2026-01-15' },
  { id: 'd3', name: 'Operations', description: 'Process management and efficiency', head: 'Priya Nair', memberCount: 4, color: '#10b981', createdAt: '2026-02-01' },
  { id: 'd4', name: 'Finance', description: 'Financial planning, reporting, and compliance', head: 'Tom Bergmann', memberCount: 3, color: '#f59e0b', createdAt: '2026-02-14' },
  { id: 'd5', name: 'Customer Success', description: 'Account management and retention', head: 'Elena Vasquez', memberCount: 5, color: '#06b6d4', createdAt: '2026-03-01' },
  { id: 'd6', name: 'Revenue', description: 'Sales and revenue generation', head: 'Marcus Webb', memberCount: 4, color: '#8b5cf6', createdAt: '2026-03-10' },
  { id: 'd7', name: 'HR & People', description: 'People operations, hiring, and culture', head: '', memberCount: 2, color: '#ec4899', createdAt: '2026-03-15' },
  { id: 'd8', name: 'Legal & Compliance', description: 'Legal affairs and regulatory compliance', head: '', memberCount: 2, color: '#ef4444', createdAt: '2026-04-01' },
];

const STORAGE_KEY = 'dt_departments';

function load(): Department[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function save(depts: Department[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(depts)); } catch {}
}

export function useDepartments() {
  const [departments, setDepartments] = useState<Department[]>(() => load() ?? DEFAULT_DEPARTMENTS);

  useEffect(() => { save(departments); }, [departments]);

  const addDepartment = useCallback((data: Pick<Department, 'name' | 'description' | 'head' | 'color'>) => {
    const newDept: Department = {
      id: 'd_' + Date.now(),
      name: data.name,
      description: data.description,
      head: data.head,
      memberCount: 0,
      color: data.color,
      createdAt: new Date().toISOString().split('T')[0],
    };
    setDepartments(prev => [...prev, newDept]);
    return newDept;
  }, []);

  const updateDepartment = useCallback((id: string, updates: Partial<Omit<Department, 'id' | 'createdAt'>>) => {
    setDepartments(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d));
  }, []);

  const removeDepartment = useCallback((id: string) => {
    setDepartments(prev => prev.filter(d => d.id !== id));
  }, []);

  return { departments, addDepartment, updateDepartment, removeDepartment };
}

export const DEPT_NAMES = DEFAULT_DEPARTMENTS.map(d => d.name);
