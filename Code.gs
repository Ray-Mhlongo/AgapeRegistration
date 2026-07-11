var SHEET_HEADERS = [
  "Household ID",
  "Relationship",
  "First Name",
  "Middle Name",
  "Surname",
  "Gender",
  "Date of Birth",
  "Age",
  "Nationality",
  "Year Joined Church",
  "Phone Number",
  "Alternative Phone",
  "Email Address",
  "Marital Status",
  "Address",
  "Emergency Contact Name",
  "Emergency Contact Relationship",
  "Emergency Contact Phone",
  "University Student",
  "External Spouse",
  "External Child",
  "Planning Center Created",
  "Planning Center Person ID",
  "Planning Center Household ID",
  "Certificate Received",
  "Attends Church",
  "Submission Timestamp",
  "Registration Date",
  "Possible Duplicate Warning",
  "Possible Duplicate Matches",
  "Source",
  "Raw JSON"
];

function doGet() {
  return HtmlService
    .createHtmlOutputFromFile("index")
    .setTitle("Agape Family Registration")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    var request = parseRequest_(e);
    var action = request.action || "submitRegistration";

    if (action === "validateDuplicate") {
      return jsonResponse_(validateDuplicate(request));
    }

    if (action === "submitRegistration") {
      return jsonResponse_(submitRegistration(request.payload || request));
    }

    throw new Error("Unknown request action.");
  } catch (error) {
    console.error(error);
    return jsonResponse_({
      ok: false,
      message: userSafeErrorMessage_(error)
    });
  }
}

function submitRegistration(payload) {
  validatePayload_(payload);

  var primaryMember = payload.primaryMember;
  var duplicate = validateDuplicate({
    phone: primaryMember.phone,
    email: primaryMember.email,
    firstName: primaryMember.firstName,
    surname: primaryMember.surname,
    dob: primaryMember.dob
  });

  if (duplicate.duplicate) {
    throw new Error("This phone number or email is already registered.");
  }

  var householdId = generateHouseholdId_();
  var planningResult;

  try {
    planningResult = syncPlanningCenter(payload, householdId);
    saveGoogleSheet(buildSheetRecords_(payload, householdId, planningResult, duplicate));
  } catch (error) {
    if (planningResult && planningResult.rollbackState) {
      rollbackPartialFailures_(planningResult.rollbackState);
    }
    throw error;
  }

  return {
    ok: true,
    householdId: householdId,
    planningCenterHouseholdId: planningResult.householdId || "",
    possibleDuplicate: !!duplicate.possibleDuplicate,
    possibleMatches: duplicate.possibleMatches || [],
    people: planningResult.people || {},
    message: "Registration submitted successfully."
  };
}

function syncPlanningCenter(payload, householdId) {
  var rollbackState = {
    createdHouseholdId: "",
    createdPersonIds: [],
    createdMemberships: []
  };

  try {
    var people = {};
    var personSequence = 1;
    var primaryMember = createOrUpdatePerson_(payload.primaryMember, {
      remoteId: buildRemoteId_(householdId, personSequence),
      relationship: "Primary Member",
      child: false,
      universityStudent: false
    }, rollbackState);

    people.primaryMember = planningPersonSummary_(primaryMember);

    var household = findReusableHousehold_(primaryMember.id) || createHousehold_({
      name: buildHouseholdName_(payload),
      primaryContactPersonId: primaryMember.id,
      people: [primaryMember.id]
    });

    if (household.created) {
      rollbackState.createdHouseholdId = household.id;
    }

    ensureHouseholdMember_(household.id, primaryMember.id, householdRoleForRelationship_("Primary Member"), rollbackState);

    if (payload.spouse && payload.spouse.attendsChurch) {
      personSequence++;
      var spouse = createOrUpdatePerson_(payload.spouse, {
        remoteId: buildRemoteId_(householdId, personSequence),
        relationship: "Spouse",
        child: false,
        universityStudent: false
      }, rollbackState);
      ensureHouseholdMember_(household.id, spouse.id, householdRoleForRelationship_("Spouse"), rollbackState);
      people.spouse = planningPersonSummary_(spouse);
    }

    (payload.children || []).forEach(function(child, index) {
      if (!shouldCreateChildInPlanningCenter_(child)) {
        return;
      }

      personSequence++;
      var createdChild = createOrUpdatePerson_(child, {
        remoteId: buildRemoteId_(householdId, personSequence),
        relationship: "Child",
        child: Number(child.age) < 18,
        universityStudent: !!child.universityStudent
      }, rollbackState);
      ensureHouseholdMember_(household.id, createdChild.id, householdRoleForRelationship_("Child"), rollbackState);
      people["child_" + index] = planningPersonSummary_(createdChild);
      people["child_" + index].universityStudent = !!child.universityStudent;
    });

    return {
      householdId: household.id,
      people: people,
      rollbackState: rollbackState
    };
  } catch (error) {
    rollbackPartialFailures_(rollbackState);
    throw error;
  }
}

function createOrUpdatePerson_(person, options, rollbackState) {
  var existing = findPlanningCenterPerson_(person);
  var attributes = personAttributes_(person, options);
  var personId;

  if (existing) {
    personId = existing.id;
    updatePerson_(personId, attributes);
  } else {
    var created = createPerson_(attributes);
    personId = created.id;
    rollbackState.createdPersonIds.push(personId);
  }

  if (person.phone) {
    ensurePhoneNumber_(personId, person.phone, true);
  }

  if (person.altPhone) {
    ensurePhoneNumber_(personId, person.altPhone, false);
  }

  if (person.email) {
    ensureEmail_(personId, person.email);
  }

  if (options.universityStudent) {
    markUniversityStudent_(personId);
  }

  return {
    id: personId,
    created: !existing,
    matched: !!existing,
    updated: !!existing
  };
}

function personAttributes_(person, options) {
  return compactObject_({
    first_name: person.firstName,
    middle_name: person.middleName,
    last_name: person.surname,
    gender: person.gender,
    birthdate: person.dob,
    child: !!options.child,
    remote_id: options.remoteId,
    medical_notes: options.universityStudent ? "University Student" : ""
  });
}

function findPlanningCenterPerson_(person) {
  if (!person) {
    return null;
  }

  var phone = normalizePhone_(person.phone || person.altPhone || "");
  if (phone) {
    var phoneMatches = searchPeople_({
      "where[search_phone_number_e164]": phone,
      per_page: 25
    });

    if (!phoneMatches.length) {
      phoneMatches = searchPeople_({
        "where[search_phone_number]": phone.replace(/\D/g, ""),
        per_page: 25
      });
    }

    if (phoneMatches.length) {
      return phoneMatches[0];
    }
  }

  var email = String(person.email || "").trim().toLowerCase();
  if (email) {
    var emailMatches = searchPeople_({
      "where[search_name_or_email]": email,
      per_page: 25
    });

    if (emailMatches.length) {
      return emailMatches[0];
    }
  }

  if (person.firstName && person.surname && person.dob) {
    var nameDobMatches = searchPeople_({
      "where[first_name]": person.firstName,
      "where[last_name]": person.surname,
      "where[birthdate]": normalizeDateValue_(person.dob),
      per_page: 25
    });

    for (var i = 0; i < nameDobMatches.length; i++) {
      if (personDataMatchesNameDob_(nameDobMatches[i], person)) {
        return nameDobMatches[i];
      }
    }
  }

  return null;
}

function personDataMatchesNameDob_(personData, person) {
  var attributes = personData.attributes || {};

  return normalizeName_(attributes.first_name) === normalizeName_(person.firstName) &&
    normalizeName_(attributes.last_name) === normalizeName_(person.surname) &&
    normalizeDateValue_(attributes.birthdate) === normalizeDateValue_(person.dob);
}

function searchPeople_(params) {
  var response = pcoRequest_("get", "/people/v2/people", null, params);
  return response.data || [];
}

function createPerson_(attributes) {
  var response = pcoRequest_("post", "/people/v2/people", {
    data: {
      type: "Person",
      attributes: attributes
    }
  });

  var personId = response.data && response.data.id;
  if (!personId) {
    throw new Error("Planning Center did not return a person ID.");
  }

  return {
    id: personId,
    raw: response
  };
}

function updatePerson_(personId, attributes) {
  return pcoRequest_("patch", "/people/v2/people/" + encodeURIComponent(personId), {
    data: {
      type: "Person",
      id: String(personId),
      attributes: compactObject_(attributes)
    }
  });
}

function ensurePhoneNumber_(personId, phone, primary) {
  var normalized = normalizePhone_(phone);
  if (!normalized) {
    return null;
  }

  var existing = listPersonRelationships_(personId, "phone_numbers");
  for (var i = 0; i < existing.length; i++) {
    var attributes = existing[i].attributes || {};
    if (normalizePhone_(attributes.number) === normalized) {
      return existing[i];
    }
  }

  return createRelationship_("phone", personId, {
    number: normalized,
    location: "Mobile",
    primary: !!primary
  });
}

function ensureEmail_(personId, email) {
  var normalized = String(email || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  var existing = listPersonRelationships_(personId, "emails");
  for (var i = 0; i < existing.length; i++) {
    var attributes = existing[i].attributes || {};
    if (String(attributes.address || "").trim().toLowerCase() === normalized) {
      return existing[i];
    }
  }

  return createRelationship_("email", personId, {
    address: normalized,
    location: "Home",
    primary: true
  });
}

function listPersonRelationships_(personId, relationshipPath) {
  var response = pcoRequest_("get", "/people/v2/people/" + encodeURIComponent(personId) + "/" + relationshipPath, null, {
    per_page: 100
  });

  return response.data || [];
}

function createRelationship_(type, personId, attributes) {
  if (type === "phone") {
    return pcoRequest_("post", "/people/v2/people/" + encodeURIComponent(personId) + "/phone_numbers", {
      data: {
        type: "PhoneNumber",
        attributes: compactObject_(attributes)
      }
    });
  }

  if (type === "email") {
    return pcoRequest_("post", "/people/v2/people/" + encodeURIComponent(personId) + "/emails", {
      data: {
        type: "Email",
        attributes: compactObject_(attributes)
      }
    });
  }

  throw new Error("Unsupported Planning Center relationship type.");
}

function findReusableHousehold_(primaryMemberPersonId) {
  var households = getPersonHouseholds_(primaryMemberPersonId);

  if (!households.length) {
    return null;
  }

  return {
    id: households[0].id,
    created: false,
    raw: households[0]
  };
}

function getPersonHouseholds_(personId) {
  var response = pcoRequest_("get", "/people/v2/people/" + encodeURIComponent(personId) + "/households", null, {
    per_page: 100
  });

  return response.data || [];
}

function createHousehold_(household) {
  var peopleRelationships = household.people.map(function(personId) {
    return {
      type: "Person",
      id: String(personId)
    };
  });

  var response = pcoRequest_("post", "/people/v2/households", {
    data: {
      type: "Household",
      attributes: {
        name: household.name
      },
      relationships: {
        people: {
          data: peopleRelationships
        },
        primary_contact: {
          data: {
            type: "Person",
            id: String(household.primaryContactPersonId)
          }
        }
      }
    }
  });

  var householdId = response.data && response.data.id;
  if (!householdId) {
    throw new Error("Planning Center did not return a household ID.");
  }

  return {
    id: householdId,
    created: true,
    raw: response
  };
}

function ensureHouseholdMember_(householdId, personId, householdRole, rollbackState) {
  var memberships = listHouseholdMemberships_(householdId);
  var existing = findHouseholdMembershipForPerson_(memberships, personId);

  if (existing) {
    updateHouseholdMembership_(householdId, existing.id, householdRole);
    return {
      id: existing.id,
      created: false
    };
  }

  var membership = createHouseholdMembership_(householdId, personId, householdRole);
  rollbackState.createdMemberships.push({
    householdId: householdId,
    membershipId: membership.id
  });

  return {
    id: membership.id,
    created: true
  };
}

function listHouseholdMemberships_(householdId) {
  var response = pcoRequest_("get", "/people/v2/households/" + encodeURIComponent(householdId) + "/household_memberships", null, {
    include: "person",
    per_page: 100
  });

  return response.data || [];
}

function findHouseholdMembershipForPerson_(memberships, personId) {
  for (var i = 0; i < memberships.length; i++) {
    var personRelationship = memberships[i].relationships &&
      memberships[i].relationships.person &&
      memberships[i].relationships.person.data;

    if (personRelationship && String(personRelationship.id) === String(personId)) {
      return memberships[i];
    }
  }

  return null;
}

function createHouseholdMembership_(householdId, personId, householdRole) {
  var response = pcoRequest_("post", "/people/v2/households/" + encodeURIComponent(householdId) + "/household_memberships", {
    data: {
      type: "HouseholdMembership",
      attributes: {
        household_role: householdRole,
        pending: false
      },
      relationships: {
        person: {
          data: {
            type: "Person",
            id: String(personId)
          }
        }
      }
    }
  });

  var membershipId = response.data && response.data.id;
  if (!membershipId) {
    throw new Error("Planning Center did not return a household membership ID.");
  }

  return {
    id: membershipId,
    raw: response
  };
}

function updateHouseholdMembership_(householdId, membershipId, householdRole) {
  return pcoRequest_("patch", "/people/v2/households/" + encodeURIComponent(householdId) + "/household_memberships/" + encodeURIComponent(membershipId), {
    data: {
      type: "HouseholdMembership",
      id: String(membershipId),
      attributes: {
        household_role: householdRole,
        pending: false
      }
    }
  });
}

function householdRoleForRelationship_(relationship) {
  // Planning Center currently limits household_role to adult,
  // child_or_dependent, other_adult, or parent_guardian. Primary Member and
  // Spouse map to adult; Child maps to child_or_dependent.
  if (relationship === "Primary Member" || relationship === "Spouse") {
    return "adult";
  }

  if (relationship === "Child") {
    return "child_or_dependent";
  }

  return "other_adult";
}

function planningPersonSummary_(result) {
  return {
    id: result.id || "",
    created: !!result.created,
    matched: !!result.matched,
    updated: !!result.updated
  };
}

function saveGoogleSheet(records) {
  var sheet = getSheet_();
  ensureHeaders_(sheet);

  if (!records.length) {
    return;
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var rows = records.map(function(record) {
    return headers.map(function(header) {
      return record[header] || "";
    });
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

function validateDuplicate(input) {
  var phone = normalizePhone_(input.phone || "");
  var email = String(input.email || "").trim().toLowerCase();
  var firstName = normalizeName_(input.firstName || "");
  var surname = normalizeName_(input.surname || "");
  var dob = normalizeDateValue_(input.dob || "");
  var result = {
    ok: true,
    duplicate: false,
    possibleDuplicate: false,
    matches: [],
    possibleMatches: []
  };

  if (!phone && !email && (!firstName || !surname || !dob)) {
    return result;
  }

  var sheet = getSheet_();
  ensureHeaders_(sheet);

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    return result;
  }

  var headerMap = headerMap_(data[0]);
  var phoneColumn = headerMap["Phone Number"];
  var emailColumn = headerMap["Email Address"];
  var householdColumn = headerMap["Household ID"];
  var relationshipColumn = headerMap.Relationship;
  var firstNameColumn = headerMap["First Name"];
  var surnameColumn = headerMap.Surname;
  var dobColumn = headerMap["Date of Birth"];

  for (var rowIndex = 1; rowIndex < data.length; rowIndex++) {
    var row = data[rowIndex];
    var rowPhone = normalizePhone_(row[phoneColumn] || "");
    var rowEmail = String(row[emailColumn] || "").trim().toLowerCase();
    var phoneMatches = phone && rowPhone && rowPhone === phone;
    var emailMatches = email && rowEmail && rowEmail === email;
    var matchSummary = {
      householdId: row[householdColumn] || "",
      relationship: row[relationshipColumn] || "",
      name: [row[firstNameColumn] || "", row[surnameColumn] || ""].join(" ").trim()
    };

    if (phoneMatches || emailMatches) {
      result.duplicate = true;
      result.matches.push(matchSummary);
      continue;
    }

    if (!result.duplicate && firstName && surname && dob) {
      var rowFirstName = normalizeName_(row[firstNameColumn] || "");
      var rowSurname = normalizeName_(row[surnameColumn] || "");
      var rowDob = normalizeDateValue_(row[dobColumn] || "");

      if (rowFirstName === firstName && rowSurname === surname && rowDob === dob) {
        result.possibleDuplicate = true;
        result.possibleMatches.push(matchSummary);
      }
    }
  }

  if (result.duplicate) {
    result.possibleDuplicate = false;
    result.possibleMatches = [];
  }

  return result;
}

function buildSheetRecords_(payload, householdId, planningResult, duplicate) {
  var records = [];
  var rawJson = JSON.stringify(payload);
  var pcoHouseholdId = planningResult.householdId || "";
  var duplicateWarning = !!(duplicate && duplicate.possibleDuplicate);
  var duplicateMatches = buildDuplicateMatchSummary_(duplicate);

  records.push(buildPersonRecord_(payload.primaryMember, {
    householdId: householdId,
    relationship: "Primary Member",
    household: payload.household,
    pcoHouseholdId: pcoHouseholdId,
    planningPerson: planningResult.people.primaryMember,
    externalSpouse: false,
    externalChild: false,
    universityStudent: false,
    attendsChurch: true,
    submittedAt: payload.submittedAt,
    duplicateWarning: duplicateWarning,
    duplicateMatches: duplicateMatches,
    source: payload.source,
    rawJson: rawJson
  }));

  if (payload.spouse) {
    records.push(buildPersonRecord_(payload.spouse, {
      householdId: householdId,
      relationship: "Spouse",
      household: payload.household,
      pcoHouseholdId: pcoHouseholdId,
      planningPerson: planningResult.people.spouse,
      externalSpouse: !payload.spouse.attendsChurch,
      externalChild: false,
      universityStudent: false,
      attendsChurch: !!payload.spouse.attendsChurch,
      submittedAt: payload.submittedAt,
      duplicateWarning: duplicateWarning,
      duplicateMatches: duplicateMatches,
      source: payload.source,
      rawJson: rawJson
    }));
  }

  (payload.children || []).forEach(function(child, index) {
    var age = Number(child.age);
    records.push(buildPersonRecord_(child, {
      householdId: householdId,
      relationship: "Child",
      household: payload.household,
      pcoHouseholdId: pcoHouseholdId,
      planningPerson: planningResult.people["child_" + index],
      externalSpouse: false,
      externalChild: !child.attendsChurch,
      universityStudent: age >= 17 && !!child.universityStudent,
      attendsChurch: !!child.attendsChurch,
      submittedAt: payload.submittedAt,
      duplicateWarning: duplicateWarning,
      duplicateMatches: duplicateMatches,
      source: payload.source,
      rawJson: rawJson
    }));
  });

  return records;
}

function buildPersonRecord_(person, meta) {
  var household = meta.household || {};
  var planningPerson = meta.planningPerson || {};
  var submittedAt = meta.submittedAt || new Date().toISOString();

  return {
    "Household ID": meta.householdId,
    "Relationship": meta.relationship,
    "First Name": person.firstName || "",
    "Middle Name": person.middleName || "",
    "Surname": person.surname || "",
    "Gender": person.gender || "",
    "Date of Birth": person.dob || "",
    "Age": person.age || "",
    "Nationality": person.nationality || "",
    "Year Joined Church": person.yearJoined || "",
    "Phone Number": person.phone || "",
    "Alternative Phone": person.altPhone || "",
    "Email Address": person.email || "",
    "Marital Status": household.maritalStatus === "Other" ? household.maritalOther : household.maritalStatus,
    "Address": buildAddress_(household),
    "Emergency Contact Name": household.emergencyContactName || "",
    "Emergency Contact Relationship": household.emergencyRelationship || "",
    "Emergency Contact Phone": household.emergencyPhone || "",
    "University Student": yesNo_(meta.universityStudent),
    "External Spouse": yesNo_(meta.externalSpouse),
    "External Child": yesNo_(meta.externalChild),
    "Planning Center Created": yesNo_(!!planningPerson.created),
    "Planning Center Person ID": planningPerson.id || "",
    "Planning Center Household ID": meta.pcoHouseholdId || "",
    "Certificate Received": person.certificateReceived || "",
    "Attends Church": yesNo_(meta.attendsChurch),
    "Submission Timestamp": submittedAt,
    "Registration Date": formatRegistrationDate_(submittedAt),
    "Possible Duplicate Warning": yesNo_(meta.duplicateWarning),
    "Possible Duplicate Matches": meta.duplicateMatches || "",
    "Source": meta.source || "",
    "Raw JSON": meta.rawJson || ""
  };
}

function buildDuplicateMatchSummary_(duplicate) {
  var matches = duplicate && duplicate.possibleMatches ? duplicate.possibleMatches : [];

  return matches.map(function(match) {
    return [
      match.householdId || "",
      match.relationship || "",
      match.name || ""
    ].filter(Boolean).join(" - ");
  }).join("; ");
}

function validatePayload_(payload) {
  if (!payload || !payload.primaryMember || !payload.household) {
    throw new Error("Registration payload is incomplete.");
  }

  requireFields_(payload.primaryMember, ["firstName", "surname", "gender", "dob", "phone", "certificateReceived"], "Primary member");
  requireFields_(payload.household, ["houseNumber", "streetName", "town", "province", "maritalStatus", "emergencyContactName", "emergencyRelationship", "emergencyPhone"], "Family");

  if (payload.household.maritalStatus === "Married") {
    if (!payload.household.spouseAttends) {
      throw new Error("Spouse answer is required.");
    }

    if (!payload.spouse) {
      throw new Error("Spouse details are required.");
    }

    if (payload.spouse.attendsChurch) {
      requireFields_(payload.spouse, ["firstName", "surname", "gender", "dob", "phone", "certificateReceived"], "Spouse");
    } else {
      requireFields_(payload.spouse, ["firstName", "surname", "phone"], "External spouse");
    }
  }

  (payload.children || []).forEach(function(child, index) {
    requireFields_(child, ["firstName", "surname", "gender", "dob", "age"], "Child " + (index + 1));

    if (typeof child.attendsChurch === "undefined" || child.attendsChurch === null || child.attendsChurch === "") {
      throw new Error("Church attendance answer is required for Child " + (index + 1) + ".");
    }

    if (child.attendsChurch) {
      var age = Number(child.age);

      if (age >= 17 && child.universityStudent !== true && child.universityStudent !== false) {
        throw new Error("University student answer is required for Child " + (index + 1) + ".");
      }

      if (age >= 18 && !child.universityStudent) {
        throw new Error("Adult children who are not full time university students must complete their own registration.");
      }
    }
  });
}

function requireFields_(object, fields, label) {
  fields.forEach(function(field) {
    if (!object[field]) {
      throw new Error(label + " is missing " + field + ".");
    }
  });
}

function shouldCreateChildInPlanningCenter_(child) {
  if (!child.attendsChurch) {
    return false;
  }

  if (Number(child.age) < 18) {
    return true;
  }

  return !!child.universityStudent;
}

function generateHouseholdId_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var props = PropertiesService.getScriptProperties();
    var counter = Number(props.getProperty("HOUSEHOLD_COUNTER") || deriveHouseholdCounterFromSheet_()) + 1;
    props.setProperty("HOUSEHOLD_COUNTER", String(counter));
    return "HH" + String(counter).padStart(6, "0");
  } finally {
    lock.releaseLock();
  }
}

function deriveHouseholdCounterFromSheet_() {
  var sheet = getSheet_();
  ensureHeaders_(sheet);
  var values = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues();
  var max = 0;

  values.forEach(function(row) {
    var value = String(row[0] || "");
    var match = value.match(/^HH(\d+)$/);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  });

  return max;
}

function getSheet_() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("SHEET_ID");
  var sheetName = props.getProperty("SHEET_NAME");

  if (!sheetId || !sheetName) {
    throw new Error("SHEET_ID and SHEET_NAME script properties are required.");
  }

  var spreadsheet = SpreadsheetApp.openById(sheetId);
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  return sheet;
}

function ensureHeaders_(sheet) {
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var currentHeaders = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  var hasAnyHeader = currentHeaders.some(function(value) {
    return !!value;
  });

  if (!hasAnyHeader) {
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
    return;
  }

  var headerLookup = {};
  currentHeaders.forEach(function(header) {
    if (header) {
      headerLookup[header] = true;
    }
  });

  var missing = SHEET_HEADERS.filter(function(header) {
    return !headerLookup[header];
  });

  if (missing.length) {
    sheet.getRange(1, currentHeaders.length + 1, 1, missing.length).setValues([missing]);
  }
}

function pcoRequest_(method, path, payload, params) {
  var config = getPlanningCenterConfig_();
  var url = config.baseUrl.replace(/\/$/, "") + path + queryString_(params);
  var options = {
    method: method,
    muteHttpExceptions: true,
    headers: {
      Authorization: "Basic " + Utilities.base64Encode(config.appId + ":" + config.secret),
      Accept: "application/json",
      "Content-Type": "application/vnd.api+json"
    }
  };

  if (payload) {
    options.payload = JSON.stringify(payload);
  }

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var text = response.getContentText();
  var body = text ? JSON.parse(text) : {};

  if (code < 200 || code >= 300) {
    throw new Error("Planning Center request failed with status " + code + ": " + text);
  }

  return body;
}

function queryString_(params) {
  var keys = Object.keys(params || {}).filter(function(key) {
    var value = params[key];
    return value !== "" && value !== null && typeof value !== "undefined";
  });

  if (!keys.length) {
    return "";
  }

  return "?" + keys.map(function(key) {
    return encodeURIComponent(key) + "=" + encodeURIComponent(params[key]);
  }).join("&");
}

function getPlanningCenterConfig_() {
  var props = PropertiesService.getScriptProperties();
  var config = {
    baseUrl: props.getProperty("PCO_API_BASE_URL"),
    appId: props.getProperty("PCO_APP_ID"),
    secret: props.getProperty("PCO_SECRET")
  };

  if (!config.baseUrl || !config.appId || !config.secret) {
    throw new Error("PCO_API_BASE_URL, PCO_APP_ID and PCO_SECRET script properties are required.");
  }

  return config;
}

function markUniversityStudent_(personId) {
  var props = PropertiesService.getScriptProperties();
  var fieldDefinitionId = props.getProperty("PCO_UNIVERSITY_FIELD_DEFINITION_ID");

  if (!fieldDefinitionId) {
    return;
  }

  pcoRequest_("post", "/people/v2/people/" + encodeURIComponent(personId) + "/field_data", {
    data: {
      type: "FieldDatum",
      attributes: {
        value: "Yes"
      },
      relationships: {
        field_definition: {
          data: {
            type: "FieldDefinition",
            id: String(fieldDefinitionId)
          }
        }
      }
    }
  });
}

function rollbackPartialFailures_(state) {
  if (!state) {
    return;
  }

  (state.createdMemberships || []).reverse().forEach(function(membership) {
    try {
      pcoRequest_("delete", "/people/v2/households/" + encodeURIComponent(membership.householdId) + "/household_memberships/" + encodeURIComponent(membership.membershipId));
    } catch (error) {
      console.warn(error);
    }
  });

  if (state.createdHouseholdId) {
    try {
      pcoRequest_("delete", "/people/v2/households/" + encodeURIComponent(state.createdHouseholdId));
    } catch (error) {
      console.warn(error);
    }
  }

  (state.createdPersonIds || []).reverse().forEach(function(personId) {
    try {
      pcoRequest_("delete", "/people/v2/people/" + encodeURIComponent(personId));
    } catch (error) {
      console.warn(error);
    }
  });
}

function buildHouseholdName_(payload) {
  var primaryMember = payload.primaryMember || {};
  return (primaryMember.surname || primaryMember.firstName || "Agape") + " Family";
}

function buildRemoteId_(householdId, sequenceNumber) {
  return householdId + "-P" + sequenceNumber;
}

function buildAddress_(household) {
  return [
    household.houseNumber,
    household.streetName,
    household.suburb,
    household.town,
    household.province
  ].filter(Boolean).join(", ");
}

function normalizePhone_(phone) {
  var value = String(phone || "").replace(/\D/g, "");

  if (value.indexOf("27") === 0) {
    value = value.substring(2);
  }

  if (value.indexOf("0") === 0) {
    value = value.substring(1);
  }

  return value ? "+27" + value : "";
}

function normalizeName_(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeDateValue_(value) {
  if (!value) {
    return "";
  }

  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }

  var text = String(value).trim();
  var isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return isoMatch[1] + "-" + isoMatch[2] + "-" + isoMatch[3];
  }

  var date = new Date(text);
  if (!isNaN(date.getTime())) {
    return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }

  return text;
}

function formatRegistrationDate_(submittedAt) {
  var date = submittedAt ? new Date(submittedAt) : new Date();

  if (isNaN(date.getTime())) {
    date = new Date();
  }

  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function yesNo_(value) {
  return value ? "Yes" : "No";
}

function compactObject_(object) {
  var result = {};
  Object.keys(object || {}).forEach(function(key) {
    var value = object[key];
    if (value !== "" && value !== null && typeof value !== "undefined") {
      result[key] = value;
    }
  });
  return result;
}

function headerMap_(headers) {
  var map = {};
  headers.forEach(function(header, index) {
    map[header] = index;
  });
  return map;
}

function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return {};
  }

  return JSON.parse(e.postData.contents);
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function userSafeErrorMessage_(error) {
  return error && error.message ? error.message : "Something went wrong. Please try again.";
}
