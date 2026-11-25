// TEST-ONLY GUIDs for the pilot. These are NOT Kernel-issued identifiers.
export const PILOT_SENDER_GUID = '5afe0020000000000000000000000001'; // pilot human user
export const OPENAI_SERVICE_GUID = '5afe0020000000000000000000000002'; // OpenAI Guest Service
export const PILOT_THREAD_GUID = '5afe0020000000000000000000000003';
export const PILOT_SUBJECT_GUID = '5afe0020000000000000000000000004';
export const PILOT_CONTEXT = {
    thread_guid: PILOT_THREAD_GUID,
    subject_guid: PILOT_SUBJECT_GUID,
    path: [PILOT_THREAD_GUID, PILOT_SUBJECT_GUID],
};
