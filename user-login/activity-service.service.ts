import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';

@Injectable({
  providedIn: 'root'
})
export class ActivityServiceService {

  private API = environment.apiUrl;

  constructor(private http: HttpClient) { }

  getTodayActivity(userid: any) {
    return this.http.get<any>(
      `${this.API}developer/activity/today`,
      { params: { userId: userid } }
    );
  }

  getDivisionRecruiterStats(divisionId: any, accessType: any, orgid: any) {
    return this.http.get<any>(`${this.API}developer/recruiter-stats`,
      { params: { divisionId, accessType, orgid } }
    );
  }

  getDivisionRecruiterStatsNew(divisionId: string, userid: any) {
    return this.http.get<any>(`${this.API}developer/recruiter-stats-new`,
      { params: { divisionId, userid } }
    );

  }

  getDivisionRecruiter(userId: any) {
    return this.http.get<any>(`${this.API}developer/recruiter-History`,
      { params: { userId } }
    );

  }

}
