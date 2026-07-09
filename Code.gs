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
  "Source",
  "Raw JSON"
];

function doGet() {
  return HtmlService
    .createHtmlOutputFromFile("index")
    .setTitle("Agape Household Registration")
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

  var duplicate = validateDuplicate({
    phone: payload.head.phone,
    email: payload.head.email
  });

  if (duplicate.duplicate) {
    throw new Error("This phone number or email is already registered.");
  }

  var householdId = generateHouseholdId_();
  var planningResult;

  try {
    planningResult = syncPlanningCenter(payload, householdId);
    saveGoogleSheet(buildSheetRecords_(payload, householdId, planningResult));
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
    people: planningResult.people || {},
    message: "Household registration submitted successfully."
  };
}

function syncPlanningCenter(payload, householdId) {
  var rollbackState = {
    householdId: "",
    personIds: []
  };

  try {
    var people = {};
    var head = createPerson(payload.head, {
      householdId: householdId,
      relationship: "Head",
      child: false,
      universityStudent: false
    });
    rollbackState.personIds.push(head.id);
    people.head = {
      id: head.id,
      created: true
    };

    var household = createHousehold({
      name: buildHouseholdName_(payload),
      primaryContactPersonId: head.id,
      people: [head.id]
    });
    rollbackState.householdId = household.id;

    if (payload.spouse && payload.spouse.attendsChurch) {
      var spouse = createPerson(payload.spouse, {
        householdId: householdId,
        relationship: "Spouse",
        child: false,
        universityStudent: false
      });
      rollbackState.personIds.push(spouse.id);
      addHouseholdMember(household.id, spouse.id, "adult");
      people.spouse = {
        id: spouse.id,
        created: true
      };
    }

    (payload.children || []).forEach(function(child, index) {
      if (!shouldCreateChildInPlanningCenter_(child)) {
        return;
      }

      var createdChild = createPerson(child, {
        householdId: householdId,
        relationship: "Child",
        child: Number(child.age) < 18,
        universityStudent: !!child.universityStudent
      });
      rollbackState.personIds.push(createdChild.id);
      addHouseholdMember(household.id, createdChild.id, "child_or_dependent");
      people["child_" + index] = {
        id: createdChild.id,
        created: true,
        universityStudent: !!child.universityStudent
      };
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

function createPerson(person, options) {
  var attributes = compactObject_({
    first_name: person.firstName,
    middle_name: person.middleName,
    last_name: person.surname,
    gender: person.gender,
    birthdate: person.dob,
    child: !!options.child,
    remote_id: options.householdId + "-" + options.relationship + "-" + person.firstName + "-" + person.surname,
    medical_notes: options.universityStudent ? "University Student" : ""
  });

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

  if (person.phone) {
    createRelationship("phone", personId, {
      number: normalizePhone_(person.phone),
      location: "Mobile",
      primary: true
    });
  }

  if (person.altPhone) {
    createRelationship("phone", personId, {
      number: normalizePhone_(person.altPhone),
      location: "Mobile",
      primary: false
    });
  }

  if (person.email) {
    createRelationship("email", personId, {
      address: person.email,
      location: "Home",
      primary: true
    });
  }

  if (options.universityStudent) {
    markUniversityStudent_(personId);
  }

  return {
    id: personId,
    raw: response
  };
}

function updatePerson(personId, attributes) {
  return pcoRequest_("patch", "/people/v2/people/" + encodeURIComponent(personId), {
    data: {
      type: "Person",
      id: String(personId),
      attributes: compactObject_(attributes)
    }
  });
}

function createRelationship(type, personId, attributes) {
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

function createHousehold(household) {
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
    raw: response
  };
}

function addHouseholdMember(householdId, personId, householdRole) {
  return pcoRequest_("post", "/people/v2/households/" + encodeURIComponent(householdId) + "/household_memberships", {
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
}

function saveGoogleSheet(records) {
  var sheet = getSheet_();
  ensureHeaders_(sheet);

  if (!records.length) {
    return;
  }

  var rows = records.map(function(record) {
    return SHEET_HEADERS.map(function(header) {
      return record[header] || "";
    });
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, SHEET_HEADERS.length).setValues(rows);
}

function validateDuplicate(input) {
  var phone = normalizePhone_(input.phone || "");
  var email = String(input.email || "").trim().toLowerCase();
  var result = {
    ok: true,
    duplicate: false,
    matches: []
  };

  if (!phone && !email) {
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

  for (var rowIndex = 1; rowIndex < data.length; rowIndex++) {
    var row = data[rowIndex];
    var rowPhone = normalizePhone_(row[phoneColumn] || "");
    var rowEmail = String(row[emailColumn] || "").trim().toLowerCase();
    var phoneMatches = phone && rowPhone && rowPhone === phone;
    var emailMatches = email && rowEmail && rowEmail === email;

    if (phoneMatches || emailMatches) {
      result.duplicate = true;
      result.matches.push({
        householdId: row[householdColumn] || "",
        relationship: row[relationshipColumn] || "",
        name: [row[firstNameColumn] || "", row[surnameColumn] || ""].join(" ").trim()
      });
    }
  }

  return result;
}

function buildSheetRecords_(payload, householdId, planningResult) {
  var records = [];
  var rawJson = JSON.stringify(payload);
  var pcoHouseholdId = planningResult.householdId || "";

  records.push(buildPersonRecord_(payload.head, {
    householdId: householdId,
    relationship: "Head",
    household: payload.household,
    pcoHouseholdId: pcoHouseholdId,
    planningPerson: planningResult.people.head,
    externalSpouse: false,
    externalChild: false,
    universityStudent: false,
    attendsChurch: true,
    submittedAt: payload.submittedAt,
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
      source: payload.source,
      rawJson: rawJson
    }));
  }

  (payload.children || []).forEach(function(child, index) {
    records.push(buildPersonRecord_(child, {
      householdId: householdId,
      relationship: "Child",
      household: payload.household,
      pcoHouseholdId: pcoHouseholdId,
      planningPerson: planningResult.people["child_" + index],
      externalSpouse: false,
      externalChild: !child.attendsChurch,
      universityStudent: !!child.universityStudent,
      attendsChurch: !!child.attendsChurch,
      submittedAt: payload.submittedAt,
      source: payload.source,
      rawJson: rawJson
    }));
  });

  return records;
}

function buildPersonRecord_(person, meta) {
  var household = meta.household || {};
  var planningPerson = meta.planningPerson || {};

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
    "Submission Timestamp": meta.submittedAt || new Date().toISOString(),
    "Source": meta.source || "",
    "Raw JSON": meta.rawJson || ""
  };
}

function validatePayload_(payload) {
  if (!payload || !payload.head || !payload.household) {
    throw new Error("Registration payload is incomplete.");
  }

  requireFields_(payload.head, ["firstName", "surname", "gender", "dob", "phone", "certificateReceived"], "Head of household");
  requireFields_(payload.household, ["houseNumber", "streetName", "town", "province", "maritalStatus", "emergencyContactName", "emergencyRelationship", "emergencyPhone"], "Household");

  if (payload.household.maritalStatus === "Married") {
    if (!payload.household.spouseAttends) {
      throw new Error("Spouse attendance answer is required.");
    }

    if (!payload.spouse) {
      throw new Error("Spouse details are required.");
    }

    if (payload.spouse.attendsChurch) {
      requireFields_(payload.spouse, ["firstName", "surname", "gender", "dob", "phone", "certificateReceived"], "Spouse");
    } else {
      requireFields_(payload.spouse, ["firstName", "surname", "phone", "email"], "External spouse");
    }
  }

  (payload.children || []).forEach(function(child, index) {
    requireFields_(child, ["firstName", "surname", "gender", "dob"], "Child " + (index + 1));

    if (child.attendsChurch && Number(child.age) >= 18 && !child.universityStudent) {
      throw new Error("Adult children who are not full time university students must complete their own registration.");
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
  var lastColumn = Math.max(sheet.getLastColumn(), SHEET_HEADERS.length);
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

function pcoRequest_(method, path, payload) {
  var config = getPlanningCenterConfig_();
  var url = config.baseUrl.replace(/\/$/, "") + path;
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

  if (state.householdId) {
    try {
      pcoRequest_("delete", "/people/v2/households/" + encodeURIComponent(state.householdId));
    } catch (error) {
      console.warn(error);
    }
  }

  (state.personIds || []).reverse().forEach(function(personId) {
    try {
      pcoRequest_("delete", "/people/v2/people/" + encodeURIComponent(personId));
    } catch (error) {
      console.warn(error);
    }
  });
}

function buildHouseholdName_(payload) {
  return (payload.head.surname || payload.head.firstName || "Agape") + " Household";
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

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function userSafeErrorMessage_(error) {
  var message = error && error.message ? String(error.message) : "";

  if (message.indexOf("already registered") !== -1) {
    return message;
  }

  if (message.indexOf("missing") !== -1 || message.indexOf("required") !== -1) {
    return "Some required information is missing. Please review the form and try again.";
  }

  return "We could not complete the registration right now. Please try again or contact the church office.";
}
