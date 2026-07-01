import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  fetchDepartments,
  createDepartment,
  updateDepartment as svcUpdate,
  deleteDepartment,
} from '../services/departmentService';

export interface Department {
  id: string;
  name: string;
  description: string;
  head: string;
  memberCount: number;
  color: string;
  createdAt: string;
}

export const DEPT_NAMES = [
  'Leadership', 'Operations', 'Revenue', 'Customer Success',
  'Finance', 'Technology', 'Quality Assurance', 'HR & People',
];

export function useDepartments() {
  const { authedUser, currentTenant } = useAuth();
  const tenantId = currentTenant?.id;
  const actorId  = authedUser?.id;

  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) { setLoading(false); return; }
    setLoading(true);
    fetchDepartments(tenantId).then(depts => {
      setDepartments(depts);
      setLoading(false);
    });
  }, [tenantId]);

  const addDepartment = useCallback(async (
    data: Pick<Department, 'name' | 'description' | 'head' | 'color'>
  ): Promise<Department | null> => {
    if (!tenantId) return null;
    const dept = await createDepartment(tenantId, data, actorId);
    if (dept) setDepartments(prev => [...prev, dept]);
    return dept;
  }, [tenantId, actorId]);

  const updateDepartment = useCallback(async (
    id: string,
    updates: Partial<Omit<Department, 'id' | 'createdAt'>>
  ) => {
    if (!tenantId) return;
    setDepartments(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d));
    await svcUpdate(id, tenantId, updates, actorId);
  }, [tenantId, actorId]);

  const removeDepartment = useCallback(async (id: string) => {
    if (!tenantId) return;
    setDepartments(prev => prev.filter(d => d.id !== id));
    await deleteDepartment(id, tenantId, actorId);
  }, [tenantId, actorId]);

  return { departments, loading, addDepartment, updateDepartment, removeDepartment };
}
