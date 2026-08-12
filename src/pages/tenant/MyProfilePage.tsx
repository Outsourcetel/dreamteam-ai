import React from 'react';
import { useAuth } from '../../context/AuthContext';
import EmployeeProfileDrawer from '../../components/EmployeeProfileDrawer';
import { Banner } from '../../design/primitives';

// ============================================================
// My profile — your own record, without going through the admin screen.
//
// The employee record shipped reachable only from People & Access, and only by
// clicking a person's name. That put a workspace owner's own details behind a
// screen for administering everybody ELSE, and behind an unlabelled click.
// Reported exactly that way: "I still don't see employee profile to edit or
// update or even my own to update my information."
//
// Same component as the admin view. The SERVER decides what you may see and
// change — you can edit your own contact details and read your own pay, and
// the job fields are read-only unless you are an owner, admin or manager. That
// is enforced in update_employee_profile, not by rendering different forms.
// ============================================================

export default function MyProfilePage() {
  const { authedUser } = useAuth();

  if (!authedUser?.id) {
    return <Banner tone="warn">Sign in to see your record.</Banner>;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-dt-body">My profile</h1>
        <p className="text-sm text-dt-support mt-1">
          Your details. Your name, your contact information and how you are addressed
          are yours to change; job details are maintained by an owner, admin or manager.
        </p>
      </div>
      <EmployeeProfileDrawer userId={authedUser.id} inline />
    </div>
  );
}
