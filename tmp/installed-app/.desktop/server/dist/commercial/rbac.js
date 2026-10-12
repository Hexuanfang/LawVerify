const rolePermissions = {
    owner: [
        'organization.manage',
        'member.manage',
        'case.manage',
        'evidence.upload',
        'evidence.read',
        'certificate.generate',
        'audit.read',
    ],
    admin: [
        'member.manage',
        'case.manage',
        'evidence.upload',
        'evidence.read',
        'certificate.generate',
        'audit.read',
    ],
    lawyer: ['case.manage', 'evidence.upload', 'evidence.read', 'certificate.generate'],
    reviewer: ['evidence.read', 'certificate.generate'],
    assistant: ['evidence.upload', 'evidence.read'],
    viewer: ['evidence.read'],
};
export function hasPermission(role, permission) {
    return rolePermissions[role].includes(permission);
}
